#!/usr/bin/env node
// grill-board — a local question board the agent writes to and the user answers
// out of order, at their own pace. Zero dependencies.
//
//   node board.mjs serve  --state <path> [--port N] [--host H] [--title T] [--max-open N]
//   node board.mjs add    --state <path> --file <questions.json|->
//   node board.mjs new    --state <path>            # unprocessed events, advances cursor
//   node board.mjs watch  --state <path>            # one stdout line per new event
//   node board.mjs retire --state <path> --id q3 --reason "..."
//   node board.mjs note   --state <path> --text "what the agent is doing right now"
//   node board.mjs status --state <path>
//   node board.mjs export --state <path> [--out transcript.md]

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_OPEN = 8;

// Viewer preferences (theme, palette) live OUTSIDE any single board. Each board
// gets its own port, and localStorage is per-origin, so the browser alone would
// forget the choice every time a new board starts.
const PREFS = join(homedir(), '.claude', 'grill-board', 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(readFileSync(PREFS, 'utf8')); } catch { return {}; }
}
function savePrefs(next) {
  try {
    mkdirSync(dirname(PREFS), { recursive: true });
    writeFileSync(PREFS, JSON.stringify(next, null, 2));
  } catch { /* preferences are not worth failing a request over */ }
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

function statePath() {
  const p = args.state || process.env.GRILL_BOARD_STATE;
  if (!p) die('missing --state <path>');
  return resolve(p);
}

function die(msg) {
  process.stderr.write(`grill-board: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- state

function blank(title) {
  return {
    version: 1,
    // Namespaces the page's localStorage. Question ids restart at q1 on every
    // board, so without this a new board inherits the last one's drafts.
    boardId: Math.random().toString(36).slice(2, 10),
    title: title || 'Grill board',
    subtitle: '',
    createdAt: new Date().toISOString(),
    agentNote: '',
    agentNoteAt: null,
    nextId: 1,
    nextEvent: 1,
    cursor: 0,
    maxOpen: DEFAULT_MAX_OPEN,
    questions: [],
    events: [],
  };
}

function load(p, { create = false, title } = {}) {
  if (!existsSync(p)) {
    if (!create) die(`no board at ${p} — run \`serve\` first`);
    mkdirSync(dirname(p), { recursive: true });
    const s = blank(title);
    save(p, s);
    return s;
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    die(`board file is corrupt (${e.message})`);
  }
}

// Write a sibling temp file then rename over the target. rename(2) within a
// directory is atomic, so a concurrent reader sees either the whole old board
// or the whole new one — never a half-written file. (Writing straight to `p`
// would let the watcher and the page read a torn JSON mid-save.)
function save(p, s) {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  try {
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// The ways of saying "I can't answer this yet". Each asks for a different thing
// back, and the agent's response differs accordingly.
const ASK_KINDS = ['simpler', 'implications', 'perspective'];

// `serve` and `add` are deliberately issued together, and the agent posts while
// the page is answering, so two writers overlapping is routine here rather than
// exotic. Read-modify-write alone loses one of them silently — a title, an
// answer, a whole batch — so the section is held under an exclusive lock.
// `wx` fails when the file exists, and that check-and-create is atomic.
const LOCK_STALE_MS = 5000;

function withLock(p, fn) {
  const lock = `${p}.lock`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Reclaim a lock abandoned by a process that died mid-write.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch { /* it vanished under us; just retry */ }
      if (Date.now() > deadline) die(`board lock is stuck — delete ${lock}`);
      const until = Date.now() + 4; // the critical section is about a millisecond
      while (Date.now() < until) { /* spin */ }
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

function mutate(p, fn) {
  mkdirSync(dirname(p), { recursive: true });
  return withLock(p, () => {
    const s = existsSync(p) ? load(p) : blank();
    const result = fn(s);
    promote(s);
    save(p, s);
    return result;
  });
}

// The queue: only ever show `maxOpen` questions at once. Everything the agent
// writes beyond that waits in `queued` and is released as answers land, so the
// board stays answerable instead of becoming a wall of forty prompts.
function promote(s) {
  const max = s.maxOpen || DEFAULT_MAX_OPEN;
  let open = s.questions.filter((q) => q.status === 'open').length;
  for (const q of s.questions) {
    if (open >= max) break;
    if (q.status === 'queued') { q.status = 'open'; q.openedAt = new Date().toISOString(); open++; }
  }
}

function pushEvent(s, ev) {
  s.events.push({ n: s.nextEvent++, at: new Date().toISOString(), ...ev });
}

// ---------------------------------------------------------------- questions

function addQuestions(s, list) {
  const added = [];
  for (const raw of list) {
    const parent = raw.parentId ? s.questions.find((q) => q.id === raw.parentId) : null;
    const id = `q${s.nextId++}`;
    const q = {
      id,
      parentId: parent ? parent.id : null,
      depth: parent ? (parent.depth || 0) + 1 : 0,
      thread: raw.thread || (parent ? parent.thread : 'General'),
      title: String(raw.title || '').trim(),
      context: raw.context || '',
      recommendation: raw.recommendation || '',
      options: (raw.options || []).map((o, i) => ({
        key: o.key || String.fromCharCode(97 + i),
        label: String(o.label || ''),
        detail: o.detail || '',
        recommended: !!o.recommended,
      })),
      multi: !!raw.multi,
      status: raw.queued ? 'queued' : 'open',
      askedAt: new Date().toISOString(),
      openedAt: raw.queued ? null : new Date().toISOString(),
      answer: null,
      retiredReason: null,
    };
    if (!q.title) continue;
    s.questions.push(q);
    added.push(q.id);
  }
  // Anything past the cap falls back into the queue.
  let open = 0;
  const max = s.maxOpen || DEFAULT_MAX_OPEN;
  for (const q of s.questions) {
    if (q.status !== 'open') continue;
    open++;
    if (open > max) q.status = 'queued';
  }
  return added;
}

// ---------------------------------------------------------------- server

function lanAddress() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function findPort(host, preferred) {
  const candidates = preferred ? [Number(preferred)] : Array.from({ length: 60 }, (_, i) => 7800 + i);
  for (const port of candidates) {
    const free = await new Promise((res) => {
      const probe = createServer();
      probe.once('error', () => res(false));
      probe.once('listening', () => probe.close(() => res(true)));
      probe.listen(port, host);
    });
    if (free) return port;
  }
  die('no free port in 7800-7859');
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { rej(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { res(data ? JSON.parse(data) : {}); } catch (e) { rej(e); }
    });
    req.on('error', rej);
  });
}

async function serve() {
  const p = statePath();
  // mutate creates the board if it isn't there, under the lock — so a concurrent
  // `add` can win the race to create it without either of them losing anything.
  mutate(p, (cur) => {
    if (args.title) cur.title = args.title;
    if (args.subtitle) cur.subtitle = String(args.subtitle);
    if (args['max-open']) cur.maxOpen = Number(args['max-open']);
  });

  const host = args.host || '0.0.0.0';
  const port = await findPort(host, args.port);
  // Read per request rather than once at boot, so editing board.html doesn't
  // need a restart. Only page loads hit this; polling goes to /api/state.
  const html = () => readFileSync(join(HERE, 'board.html'), 'utf8');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html());
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const cur = load(p);
        // The cursor is the agent's bookkeeping; the page never needs it.
        return json(res, 200, {
          boardId: cur.boardId || 'legacy',
          prefs: loadPrefs(),
          title: cur.title,
          subtitle: cur.subtitle,
          agentNote: cur.agentNote,
          agentNoteAt: cur.agentNoteAt,
          maxOpen: cur.maxOpen,
          rev: cur.nextId * 1e6 + cur.nextEvent,
          questions: cur.questions,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = await readBody(req);
        const out = mutate(p, (cur) => {
          const q = cur.questions.find((x) => x.id === body.id);
          if (!q) return { ok: false, error: 'unknown question' };
          q.status = 'answered';
          q.answer = {
            keys: Array.isArray(body.keys) ? body.keys : [],
            text: typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null,
            at: new Date().toISOString(),
          };
          pushEvent(cur, { type: 'answer', id: q.id, thread: q.thread, title: q.title, answer: q.answer });
          return { ok: true };
        });
        return json(res, out.ok ? 200 : 404, out);
      }

      // One endpoint for every "I can't answer this yet" request. They differ
      // only in what they ask for, so they share a shape rather than each
      // getting a route of its own.
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await readBody(req);
        const kind = String(body.kind || '');
        if (!ASK_KINDS.includes(kind)) return json(res, 400, { ok: false, error: 'unknown kind' });
        const out = mutate(p, (cur) => {
          const q = cur.questions.find((x) => x.id === body.id);
          if (!q) return { ok: false, error: 'unknown question' };
          q.ask = { kind, at: new Date().toISOString() };
          pushEvent(cur, { type: 'ask', kind, id: q.id, thread: q.thread, title: q.title });
          return { ok: true };
        });
        return json(res, out.ok ? 200 : 404, out);
      }

      if (req.method === 'POST' && url.pathname === '/api/reopen') {
        const body = await readBody(req);
        const out = mutate(p, (cur) => {
          const q = cur.questions.find((x) => x.id === body.id);
          if (!q) return { ok: false, error: 'unknown question' };
          q.status = 'open';
          q.answer = null;
          return { ok: true };
        });
        return json(res, out.ok ? 200 : 404, out);
      }

      if (req.method === 'POST' && url.pathname === '/api/prefs') {
        const body = await readBody(req);
        const next = loadPrefs();
        if (body.theme === 'light' || body.theme === 'dark') next.theme = body.theme;
        if (typeof body.palette === 'string' && /^[a-z0-9-]{1,32}$/.test(body.palette)) next.palette = body.palette;
        savePrefs(next);
        return json(res, 200, { ok: true, prefs: next });
      }

      if (req.method === 'POST' && url.pathname === '/api/message') {
        const body = await readBody(req);
        mutate(p, (cur) => {
          pushEvent(cur, { type: 'message', text: String(body.text || '') });
        });
        return json(res, 200, { ok: true });
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  server.listen(port, host, () => {
    const lan = lanAddress();
    const local = `http://localhost:${port}`;
    // Both URLs land in a file next to the state so the caller can read them
    // without waiting on this process's stdout.
    writeFileSync(join(dirname(p), 'url'), lan && host === '0.0.0.0' ? `${local}\nhttp://${lan}:${port}\n` : `${local}\n`);
    process.stdout.write(`grill-board listening\n`);
    process.stdout.write(`  local  ${local}\n`);
    if (lan && host === '0.0.0.0') process.stdout.write(`  phone  http://${lan}:${port}\n`);
    process.stdout.write(`  state  ${p}\n`);
  });
}

// ---------------------------------------------------------------- cli verbs

function cmdAdd() {
  const p = statePath();
  // No pre-creation needed: mutate makes the board under the lock. `add` is
  // meant to be issued in the same breath as `serve`, so either may be first.
  const src = args.file === '-' || !args.file ? readFileSync(0, 'utf8') : readFileSync(resolve(args.file), 'utf8');
  let list;
  try { list = JSON.parse(src); } catch (e) { die(`questions JSON is invalid: ${e.message}`); }
  if (!Array.isArray(list)) list = [list];
  const added = mutate(p, (s) => addQuestions(s, list));
  const after = load(p);
  const open = after.questions.filter((q) => q.status === 'open').length;
  const queued = after.questions.filter((q) => q.status === 'queued').length;
  process.stdout.write(`added ${added.length}: ${added.join(' ')} — ${open} open, ${queued} queued\n`);
}

function cmdNew() {
  const p = statePath();
  const out = mutate(p, (s) => {
    const fresh = s.events.filter((e) => e.n > (s.cursor || 0));
    s.cursor = s.events.length ? s.events[s.events.length - 1].n : 0;
    return fresh;
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function describe(ev) {
  if (ev.type === 'answer') {
    const picked = (ev.answer.keys || []).join(',') || '—';
    const note = ev.answer.text ? ` note: ${JSON.stringify(ev.answer.text.slice(0, 120))}` : '';
    return `[answer] ${ev.id} (${ev.thread}) picked ${picked}${note}`;
  }
  if (ev.type === 'ask') {
    const want = {
      simpler: 'too dense — re-ask it plainly',
      implications: 'wants what each choice would actually mean',
      perspective: 'wants the angle needed to judge it',
    }[ev.kind] || ev.kind;
    return `[ask:${ev.kind}] ${ev.id} (${ev.thread}) ${want}`;
  }
  if (ev.type === 'message') return `[message] ${JSON.stringify(String(ev.text).slice(0, 160))}`;
  return `[${ev.type}] ${ev.id || ''}`;
}

function counts(s) {
  const by = { open: 0, queued: 0, answered: 0, retired: 0 };
  for (const q of s.questions) by[q.status] = (by[q.status] || 0) + 1;
  return by;
}

// Deliberately does not use load(): that calls die() on a missing or unparseable
// board, and die() exits the process. The watcher is armed in the same message
// as `serve`, so "not there yet" is normal — and exiting would silently end the
// whole loop, leaving answers with nothing listening.
function peek(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

async function cmdWatch() {
  const p = statePath();
  let seen = 0;
  let announcedDrain = false;
  while (!existsSync(p)) await sleep(200); // wait for serve/add to create it
  // Start from the end: the agent has already seen whatever is on disk when the
  // watch is armed, so replaying history would double-process it.
  const first = peek(p);
  if (first) seen = first.events.reduce((m, e) => Math.max(m, e.n), 0);

  for (;;) {
    const s = peek(p);
    if (!s) { await sleep(500); continue; }
    for (const ev of s.events) {
      if (ev.n <= seen) continue;
      seen = ev.n;
      process.stdout.write(describe(ev) + '\n');
      announcedDrain = false;
    }
    const c = counts(s);
    if (c.open === 0 && c.queued === 0 && s.questions.length && !announcedDrain) {
      process.stdout.write(`[drained] board empty — ${c.answered} answered\n`);
      announcedDrain = true;
    }
    await sleep(1000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cmdRetire() {
  const p = statePath();
  const ids = String(args.id || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!ids.length) die('missing --id q3[,q4]');
  mutate(p, (s) => {
    for (const q of s.questions) {
      if (!ids.includes(q.id)) continue;
      if (q.status === 'answered') continue;
      q.status = 'retired';
      q.retiredReason = args.reason || 'no longer relevant';
    }
  });
  process.stdout.write(`retired ${ids.join(' ')}\n`);
}

function cmdNote() {
  const p = statePath();
  mutate(p, (s) => {
    s.agentNote = String(args.text || '');
    s.agentNoteAt = new Date().toISOString();
  });
  process.stdout.write('ok\n');
}

function cmdStatus() {
  const s = load(statePath());
  const c = counts(s);
  const threads = [...new Set(s.questions.map((q) => q.thread))];
  process.stdout.write(
    `${s.title}\n` +
    `  open ${c.open} · queued ${c.queued} · answered ${c.answered} · retired ${c.retired}\n` +
    `  threads: ${threads.join(', ')}\n` +
    `  unread events: ${s.events.filter((e) => e.n > (s.cursor || 0)).length}\n`
  );
}

function cmdExport() {
  const s = load(statePath());
  const lines = [`# ${s.title}`, ''];
  if (s.subtitle) lines.push(s.subtitle, '');
  const threads = [...new Set(s.questions.map((q) => q.thread))];
  for (const t of threads) {
    lines.push(`## ${t}`, '');
    for (const q of s.questions.filter((x) => x.thread === t)) {
      // Depth reads as heading level, not leading spaces — indented content
      // under an indented heading turns into a code block in strict parsers.
      const hashes = '#'.repeat(Math.min(3 + (q.depth || 0), 6));
      lines.push(`${hashes} ${q.title}`, '');
      if (q.context) lines.push(q.context, '');
      if (q.status === 'answered' && q.answer) {
        const picked = q.answer.keys
          .map((k) => (q.options.find((o) => o.key === k) || {}).label || k)
          .join(' + ');
        if (picked) lines.push(`**Answer:** ${picked}`);
        if (q.answer.text) lines.push(`**In their words:** ${q.answer.text}`);
      } else if (q.status === 'retired') {
        lines.push(`**Retired** — ${q.retiredReason}`);
      } else {
        lines.push('**Unanswered**');
      }
      if (q.ask) lines.push(`**Asked for ${q.ask.kind}.**`);
      lines.push('');
    }
  }
  const messages = s.events.filter((e) => e.type === 'message');
  if (messages.length) {
    lines.push('## Notes from the user', '');
    for (const m of messages) lines.push(`- ${m.text}`);
    lines.push('');
  }
  const md = lines.join('\n');
  if (args.out) { writeFileSync(resolve(args.out), md); process.stdout.write(`wrote ${resolve(args.out)}\n`); }
  else process.stdout.write(md);
}

// ---------------------------------------------------------------- dispatch

const verbs = {
  serve, add: cmdAdd, new: cmdNew, watch: cmdWatch, retire: cmdRetire,
  note: cmdNote, status: cmdStatus, export: cmdExport,
};

if (!cmd || !verbs[cmd]) {
  process.stderr.write('usage: board.mjs <serve|add|new|watch|retire|note|status|export> --state <path>\n');
  process.exit(1);
}
await verbs[cmd]();

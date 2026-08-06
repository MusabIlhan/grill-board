#!/usr/bin/env node
// grill-board — a local question board the agent writes to and the user answers
// out of order, at their own pace. Zero dependencies.
//
//   node board.mjs serve  --state <path> [--port N] [--host H] [--title T] [--max-open N] [--token]
//   node board.mjs add    --state <path> --file <questions.json|->
//   node board.mjs new    --state <path>            # unprocessed events, advances cursor
//   node board.mjs watch  --state <path>            # one stdout line per new event
//   node board.mjs retire --state <path> --id q3 --reason "..."
//   node board.mjs note   --state <path> --text "what the agent is doing right now"
//   node board.mjs status --state <path>
//   node board.mjs export --state <path> [--out transcript.md]
//   node board.mjs mcp    --state <path>            # MCP over stdio (also at POST /mcp)
//   node board.mjs gateway [--port N] [--token]     # one stable URL that follows the current board
//
// After the questions drain the same board carries the work they decided:
//   node board.mjs build  --state <path> --file <plan.json>          # declare the build
//   node board.mjs build  --state <path> --step s2 --status done
//   node board.mjs change --state <path> --file <changes.json>       # log what was written
//   node board.mjs review --state <path>                             # hand each change back

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_OPEN = 8;

// Which board is live right now. Every `serve` claims it, so a long-running
// gateway — and the connector URL registered against it — follows whatever
// grill is currently going, instead of being nailed to one session's state file.
const CURRENT = join(homedir(), '.claude', 'grill-board', 'current');

function setCurrent(p) {
  try {
    mkdirSync(dirname(CURRENT), { recursive: true });
    writeFileSync(CURRENT, `${p}\n`);
  } catch { /* not worth failing a board over */ }
}

function getCurrent() {
  try {
    const p = readFileSync(CURRENT, 'utf8').trim();
    return p && existsSync(p) ? p : null;
  } catch { return null; }
}

// Several grills run at once here, so "newest wins" cannot be the only answer:
// each serve registers itself, and dead ones are filtered out by pid on read.
const BOARDS = join(homedir(), '.claude', 'grill-board', 'boards.json');

function readRegistry() {
  try { return JSON.parse(readFileSync(BOARDS, 'utf8')); } catch { return {}; }
}

function registerBoard(p, title, port) {
  try {
    mkdirSync(dirname(BOARDS), { recursive: true });
    const all = {};
    for (const [path, b] of Object.entries(readRegistry())) {
      if (!existsSync(path) || !b.pid) continue;
      try { process.kill(b.pid, 0); } catch { continue; } // its server is gone
      all[path] = b;
    }
    all[p] = { title: title || 'Grill board', port, pid: process.pid, at: new Date().toISOString() };
    writeFileSync(BOARDS, JSON.stringify(all, null, 2));
  } catch { /* a registry failure must not stop a board */ }
}

function liveBoards() {
  const out = {};
  for (const [p, b] of Object.entries(readRegistry())) {
    if (!existsSync(p) || !b.pid) continue;
    try { process.kill(b.pid, 0); } catch { continue; }
    out[p] = b;
  }
  // The registry only knows boards that registered themselves. One started
  // before this existed — or by an older build — would be invisible, including
  // the very board you are on, so fold the current pointer in regardless.
  const cur = getCurrent();
  if (cur && !out[cur]) {
    const s = peek(cur);
    if (s) out[cur] = { title: s.title, port: null, pid: null, at: s.createdAt };
  }
  return out;
}

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
    nextChange: 1,
    cursor: 0,
    maxOpen: DEFAULT_MAX_OPEN,
    questions: [],
    events: [],
    // A board outlives the grilling: once the questions drain it shows the work
    // being built, then hands every change back for review.
    phase: 'grilling',
    build: null,
    changes: [],
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
    // One counter the page can compare against, bumped by every write. Deriving
    // it from question and event ids instead used to work, and stopped the
    // moment a build step could change without either of them moving — the
    // board then showed a build frozen at step one until something else landed.
    s.rev = (s.rev || 0) + 1;
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
      // The one sentence a voice client reads aloud. `context` is written to be
      // READ — code, tables, file:line — and is unusable spoken, so the agent
      // authors the speakable form rather than leaving a narrator to guess.
      spoken: String(raw.spoken || '').trim(),
      // A review card's `context` is a diff — unreadable aloud. This is the same
      // change said in prose, so a voice client has something to read out when
      // they ask what actually changed.
      spokenDetail: String(raw.spokenDetail || '').trim(),
      // 'review' cards are minted from the change log rather than written by
      // hand, and answering one is a verdict on code rather than a decision.
      kind: raw.kind || 'question',
      changeId: raw.changeId || null,
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

// ------------------------------------------------- build, changes, review
// The point of the whole thing: a decision that never becomes code was a
// conversation, not an agreement. So the board keeps going past the last
// question — it shows the build happening, then hands each change back with
// the decisions that produced it attached, and a review is done against those
// rather than against a diff standing on its own.

function ensureWork(s) {
  if (!s.build) s.build = { startedAt: null, finishedAt: null, steps: [] };
  if (!Array.isArray(s.changes)) s.changes = [];
  if (!s.nextChange) s.nextChange = 1;
  return s;
}

// What the user actually settled, rendered for the top of a review card. This
// is the link that makes a review a review: without it you are asking someone
// to approve a diff and remember, unaided, what they asked for.
function decisionLine(s, qid) {
  const q = s.questions.find((x) => x.id === qid);
  if (!q) return `- \`${qid}\` — *(not on this board)*`;
  const picked = (q.answer && q.answer.keys || [])
    .map((k) => ((q.options || []).find((o) => o.key === k) || {}).label || k)
    .join(' + ');
  const said = q.answer && q.answer.text ? `“${q.answer.text}”` : '';
  const decided = [picked, said].filter(Boolean).join(' — ') || '*never answered — this was my call*';
  return `- **${qid}** ${q.title}\n  → ${decided}`;
}

// Fence long enough to survive its own contents. A diff of a markdown file
// carries ``` lines, and a three-backtick fence around one ends the block early
// — the rest of the diff then renders as prose, which reads as a broken card.
function fenceFor(text) {
  const runs = String(text).match(/`{3,}/g) || [];
  return '`'.repeat(runs.reduce((m, r) => Math.max(m, r.length + 1), 3));
}

function reviewContext(s, c) {
  const out = [];
  if (c.summary) out.push(c.summary, '');
  if ((c.files || []).length) out.push(`**Files** — ${c.files.map((f) => `\`${f}\``).join(', ')}`, '');
  if ((c.because || []).length) {
    out.push('**Because you decided**', '');
    for (const qid of c.because) out.push(decisionLine(s, qid));
    out.push('');
  }
  if (c.rev > 1) out.push(`*Revision ${c.rev} — rewritten after your last review.*`, '');
  if (c.diff) {
    const f = fenceFor(c.diff);
    out.push(`${f}diff`, String(c.diff).replace(/\n+$/, ''), f);
  }
  return out.join('\n').trim();
}

// Explicit keys rather than a/b/c: the verdict then travels in the event itself,
// so `watch`, `export` and the agent all read the same word for it.
const VERDICTS = { ok: 'looks right', revise: 'change the code', reopen: 'reopen the decision' };

function reviewCard(s, c) {
  const primary = (c.because || [])[0];
  return {
    thread: 'Review',
    kind: 'review',
    changeId: c.id,
    title: c.title,
    spoken: c.spoken || `I've made this change: ${c.title}. Does that look right to you?`,
    spokenDetail: c.summary || '',
    context: reviewContext(s, c),
    recommendation: c.risk || '',
    options: [
      { key: 'ok', label: 'Looks right', detail: 'Accepted as written.', recommended: true },
      { key: 'revise', label: 'Change the code', detail: 'The decision stands — say what to change and I rewrite it.' },
      ...(primary ? [{
        key: 'reopen',
        label: `Wrong call — reopen ${primary}`,
        detail: `Sends ${primary} back to be decided again, and this gets rebuilt from the new answer.`,
      }] : []),
    ],
  };
}

// The verdict on one change, or null while it is still out for review.
function verdictOf(s, c) {
  const q = s.questions.find((x) => x.id === c.reviewId);
  if (!q || q.status !== 'answered' || !q.answer) return null;
  const key = (q.answer.keys || [])[0] || null;
  return { key, label: VERDICTS[key] || (key ? key : 'in their own words'), text: q.answer.text || '' };
}

function logChanges(s, list) {
  ensureWork(s);
  const added = [], updated = [], unlinked = [];
  for (const raw of list) {
    const title = String(raw.title || '').trim();
    if (!title) continue;
    const fields = {
      title,
      because: (raw.because || []).map(String),
      files: (raw.files || []).map(String),
      summary: raw.summary || '',
      diff: raw.diff || '',
      risk: raw.risk || '',
      spoken: String(raw.spoken || '').trim(),
      step: raw.step || null,
    };
    if (!fields.because.length) unlinked.push(title);
    // Re-logging under the same id is the revise loop: the change is rewritten
    // in place and its review card reopens with the new diff, so the history of
    // one change stays one row instead of accumulating near-duplicates.
    const existing = raw.id ? s.changes.find((x) => x.id === raw.id) : null;
    if (existing) {
      Object.assign(existing, fields, { rev: (existing.rev || 1) + 1, at: new Date().toISOString() });
      const q = s.questions.find((x) => x.id === existing.reviewId);
      if (q) {
        // Rebuild the card wholesale rather than patching fields. A rewrite can
        // change which decision it answers to, and the "reopen q4" option names
        // that decision — patched piecemeal, it keeps pointing at the old one.
        const fresh = reviewCard(s, existing);
        Object.assign(q, {
          status: 'open', openedAt: new Date().toISOString(), answer: null, ask: null,
          title: fresh.title, spoken: fresh.spoken, spokenDetail: fresh.spokenDetail,
          context: fresh.context, recommendation: fresh.recommendation,
          options: fresh.options.map((o, i) => ({ key: o.key || String.fromCharCode(97 + i), label: o.label, detail: o.detail || '', recommended: !!o.recommended })),
        });
      }
      updated.push(existing.id);
    } else {
      s.changes.push({ id: `c${s.nextChange++}`, ...fields, rev: 1, reviewId: null, at: new Date().toISOString() });
      added.push(s.changes[s.changes.length - 1].id);
    }
  }
  return { added, updated, unlinked };
}

function mintReviews(s) {
  ensureWork(s);
  const pending = s.changes.filter((c) => !c.reviewId && c.title);
  s.build.finishedAt = s.build.finishedAt || new Date().toISOString();
  s.phase = 'review';
  if (!pending.length) return [];
  // The queue exists so a grill cannot become a wall of forty prompts. A review
  // set is different: it is finite, it is all of one thing, and revealing it a
  // few at a time leaves you unable to tell whether you have seen the change
  // that matters. So the cap is lifted to fit exactly this batch.
  const openNow = s.questions.filter((q) => q.status === 'open').length;
  s.maxOpen = Math.max(s.maxOpen || DEFAULT_MAX_OPEN, openNow + pending.length);
  const ids = addQuestions(s, pending.map((c) => reviewCard(s, c)));
  pending.forEach((c, i) => { c.reviewId = ids[i]; });
  return ids;
}

// ------------------------------------------------------- recording answers
// Shared by the HTTP API and the MCP tools, so a voice client and the page
// cannot drift into recording answers differently.

function recordAnswer(p, body) {
  return mutate(p, (cur) => {
    const q = cur.questions.find((x) => x.id === body.id);
    if (!q) return { ok: false, error: 'unknown question' };
    q.status = 'answered';
    q.answer = {
      keys: Array.isArray(body.keys) ? body.keys : [],
      text: typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null,
      at: new Date().toISOString(),
    };
    pushEvent(cur, {
      type: 'answer', id: q.id, thread: q.thread, title: q.title, answer: q.answer,
      // Carried on the event so the agent can act on a review verdict without
      // going back to look up which change the card belonged to.
      kind: q.kind || 'question',
      changeId: q.changeId || null,
      because: q.changeId ? ((cur.changes || []).find((c) => c.id === q.changeId) || {}).because || [] : undefined,
    });
    return { ok: true, id: q.id };
  });
}

function recordAsk(p, body) {
  const kind = String(body.kind || '');
  if (!ASK_KINDS.includes(kind)) return { ok: false, error: 'unknown kind' };
  return mutate(p, (cur) => {
    const q = cur.questions.find((x) => x.id === body.id);
    if (!q) return { ok: false, error: 'unknown question' };
    q.ask = { kind, at: new Date().toISOString() };
    pushEvent(cur, { type: 'ask', kind, id: q.id, thread: q.thread, title: q.title });
    return { ok: true, id: q.id };
  });
}

// ------------------------------------------------------------------- mcp
// A hand-rolled JSON-RPC subset — enough for tools, and no dependency. Served
// two ways: over stdio for a second session on this machine, and at POST /mcp
// for one that has to reach the board across a network.

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const MCP_TOOLS = [
  {
    name: 'list_questions',
    description:
      'The questions currently open on the grill board, each with the one-line spoken form and its choices. ' +
      'Ask them ONE AT A TIME in conversation — never read the whole list out.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_question',
    description:
      'The full detail behind one question — the code, tables and tradeoffs the spoken line compresses. ' +
      'Use it when they ask for the detail; read it out deliberately rather than paraphrasing.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'question id, e.g. q7' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'answer',
    description:
      'Record their answer and move on. Pass what they ACTUALLY SAID as `text` — that is the normal path, and the ' +
      'grilling session reads it. Only set `keys` when they clearly named one of the listed choices. Never invent an ' +
      'answer, and never answer on their behalf.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string', description: 'their answer in their own words' },
        keys: { type: 'array', items: { type: 'string' }, description: 'option keys, only if they named one' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'ask_better',
    description:
      'They cannot answer it as written, so send it back to be re-asked. ' +
      'simpler = too dense; implications = they want what each choice would cost them; ' +
      'perspective = they want the angle needed to judge it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, kind: { type: 'string', enum: ASK_KINDS } },
      required: ['id', 'kind'], additionalProperties: false,
    },
  },
  {
    name: 'board_status',
    description: 'How many questions are open, answered and still queued on the board you are on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_boards',
    description:
      'Every grill running right now. Several can be going at once. Call this when they mention a different subject ' +
      'from the one you are on, ask what else is running, or say you are on the wrong board.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'use_board',
    description:
      'Switch to another running grill by name. Take the name from list_boards; a distinctive fragment is enough. ' +
      'Confirm the switch out loud, because it changes which questions everything else acts on.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'board title, or part of it' } },
      required: ['name'], additionalProperties: false,
    },
  },
];

function mcpRead(p) {
  const s = p && peek(p);
  // Spoken aloud, so it says what to do rather than naming a path.
  if (!s) throw new Error('No grill board is running at the moment. Start one and I will pick it up.');
  return s;
}

function describeQuestion(q, { full = false } = {}) {
  const lines = [`${q.id} · ${q.thread}`, q.spoken || q.title];
  if (full) {
    if (q.spoken && q.title !== q.spoken) lines.push('', `Question: ${q.title}`);
    // A review card's context is a diff. Read aloud that is noise, so the
    // change's own prose stands in for it — the diff is on the page for anyone
    // who is actually looking at one.
    if (q.spokenDetail) lines.push('', q.spokenDetail, '', '(The diff itself is on the board — describe it, do not read it out.)');
    else if (q.context) lines.push('', q.context);
    if (q.recommendation) lines.push('', `Claude is least sure about: ${q.recommendation}`);
  }
  if (q.options.length) {
    lines.push('');
    for (const o of q.options) {
      lines.push(`  ${o.key}) ${o.label}${o.recommended ? '  [Claude picks this]' : ''}${o.detail ? ` — ${o.detail}` : ''}`);
    }
    if (q.multi) lines.push('  (more than one may apply)');
  }
  return lines.join('\n');
}

function callTool(p, name, a = {}) {
  if (name === 'list_questions') {
    const s = mcpRead(p);
    const open = s.questions.filter((q) => q.status === 'open');
    if (!open.length) {
      if (s.phase === 'building') {
        const b = s.build || { steps: [] };
        const done = b.steps.filter((x) => x.status === 'done').length;
        const now = b.steps.find((x) => x.status === 'running');
        return `"${s.title}" — the questions are done and Claude is building: ${done} of ${b.steps.length} steps` +
          `${now ? `, currently ${now.title}` : ''}. The changes come back here for review when it finishes.`;
      }
      return `"${s.title}" — nothing open right now. Claude may still be writing; try again shortly.`;
    }
    const reviewing = open.some((q) => q.kind === 'review');
    return [
      `"${s.title}" — ${open.length} open${reviewing ? '; these are finished changes to review, not decisions to make' : ''}.`,
      '', ...open.map((q) => describeQuestion(q) + '\n'),
    ].join('\n');
  }
  if (name === 'read_question') {
    const q = mcpRead(p).questions.find((x) => x.id === a.id);
    if (!q) return `No question ${a.id} on this board.`;
    return describeQuestion(q, { full: true });
  }
  if (name === 'answer') {
    if (!a.id) return 'Need the question id.';
    if (!a.text && !(a.keys || []).length) return 'Nothing to record — pass what they said as `text`.';
    const out = recordAnswer(p, a);
    return out.ok ? `Recorded for ${a.id}. Claude has been woken and will branch from it.` : `Could not record: ${out.error}`;
  }
  if (name === 'ask_better') {
    const out = recordAsk(p, a);
    return out.ok
      ? `Sent ${a.id} back to be re-asked (${a.kind}). It will reappear rewritten.`
      : `Could not send it back: ${out.error}`;
  }
  if (name === 'list_boards') {
    const all = Object.entries(liveBoards());
    if (!all.length) return 'No grills are running.';
    return all.map(([path, b]) => {
      const s = peek(path);
      const open = s ? s.questions.filter((q) => q.status === 'open').length : 0;
      return `"${b.title}" — ${open} open${path === p ? '   ← you are on this one' : ''}`;
    }).join('\n');
  }
  if (name === 'use_board') {
    const want = String(a.name || '').toLowerCase();
    const hit = Object.entries(liveBoards()).find(([, b]) => b.title.toLowerCase().includes(want));
    if (!hit) return `No running grill matches "${a.name}". Use list_boards to see what there is.`;
    setCurrent(hit[0]);
    const s = peek(hit[0]);
    const open = s ? s.questions.filter((q) => q.status === 'open').length : 0;
    return `Switched to "${hit[1].title}" — ${open} open. Everything from here acts on that board.`;
  }
  if (name === 'board_status') {
    const s = mcpRead(p);
    const c = counts(s);
    const base = `"${s.title}": ${c.answered} answered, ${c.open} open, ${c.queued} still queued.`;
    if (s.phase === 'building' && s.build) {
      const done = s.build.steps.filter((x) => x.status === 'done').length;
      return `${base} The questions are done — Claude is building, ${done} of ${s.build.steps.length} steps.`;
    }
    if (s.phase === 'review') {
      const out = (s.changes || []).filter((ch) => ch.reviewId);
      const left = out.filter((ch) => !verdictOf(s, ch)).length;
      return `${base} Reviewing ${out.length} change${out.length === 1 ? '' : 's'} — ${left} still without a verdict.`;
    }
    return base;
  }
  throw new Error(`unknown tool: ${name}`);
}

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Returns the reply, or null for a notification (which must not be answered).
function handleRpc(p, msg) {
  const { id, method, params } = msg || {};
  if (!method) return null;
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    const want = params && params.protocolVersion;
    return rpcOk(id, {
      protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'grill-board', version: '1.0.0' },
      instructions:
        'A board of open questions someone is answering out loud. Ask ONE at a time, in your own words, using the ' +
        'spoken line. Let them answer however they like and record what they actually said — do not push them ' +
        'towards the listed choices, and never answer for them. If they want the detail, read_question. If they ' +
        'cannot answer it as written, ask_better rather than pressing. ' +
        'Once the questions run out Claude builds what they decided, and the finished changes come back to this ' +
        'same board as review cards. Those are not decisions — each one is code that already exists, and the ' +
        'three answers are: it looks right, change the code, or the decision behind it was wrong. Never read a ' +
        'diff aloud; describe what changed and let them ask.',
    });
  }
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') return rpcOk(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      return rpcOk(id, { content: [{ type: 'text', text: callTool(p, name, (params && params.arguments) || {}) }] });
    } catch (e) {
      return rpcOk(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  return rpcErr(id, -32601, `unknown method: ${method}`);
}

// ---------------------------------------------------------------- server

function randomToken() {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
}

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

// Off by default: on a LAN board a token is friction for nothing. It becomes
// mandatory the moment the board is tunnelled somewhere public, which is what
// remote MCP needs — an open board is one a stranger can read AND answer.
let TOKEN = null;
let LOG = false;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

function authOk(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && h.slice(7) === TOKEN) return true;
  if (url.searchParams.get('t') === TOKEN) return true;
  // Also accept it as a path segment: /mcp/<token>. A connector UI that
  // normalises or strips the query string would otherwise drop the credential
  // and there would be no way to hand it one.
  const seg = url.pathname.split('/').filter(Boolean);
  return seg.length > 1 && seg[seg.length - 1] === TOKEN;
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

// The request handler, shared by `serve` (one fixed board) and `gateway` (whichever
// board is current). Resolving the path per request is the whole difference: it lets
// one tunnelled URL, registered once as a connector, follow every later grill.
function makeHandler(boardPath) {
  // Read per request rather than once at boot, so editing board.html doesn't
  // need a restart. Only page loads hit this; polling goes to /api/state.
  const html = () => readFileSync(join(HERE, 'board.html'), 'utf8');

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = boardPath();
    if (LOG) process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ua=${(req.headers['user-agent'] || '-').slice(0, 40)} accept=${(req.headers.accept || '-').slice(0, 40)}\n`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    // This server has no OAuth. Answering 401 to the discovery probes tells a
    // client the opposite — that auth exists and it should negotiate — and it
    // then has nothing to negotiate with. 404 is the honest answer.
    if (url.pathname.startsWith('/.well-known/')) { res.writeHead(404, CORS); return res.end('no oauth here'); }

    if (!authOk(req, url)) {
      // Name the scheme, so a client knows a bearer token is what's wanted
      // rather than guessing at an authorization flow.
      res.writeHead(401, { ...CORS, 'www-authenticate': 'Bearer realm="grill-board"', 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    // /mcp speaks for itself when nothing is live; every other route needs a board.
    if (!p && url.pathname !== '/mcp') return json(res, 503, { ok: false, error: 'no grill board is running' });
    try {

      // MCP, for a client that talks to the board instead of looking at it.
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        // Streamable HTTP lets a client open a channel for server-initiated
        // messages. This server never sends any, but answering 405 makes some
        // clients treat the connection as failed — so hold an idle stream open.
        if (req.method === 'GET') {
          res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(': open\n\n');
          const beat = setInterval(() => res.write(': ping\n\n'), 25000);
          req.on('close', () => clearInterval(beat));
          return;
        }
        if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end('POST JSON-RPC here'); }
        const body = await readBody(req);
        const batch = Array.isArray(body);
        const replies = (batch ? body : [body]).map((m) => handleRpc(p, m)).filter(Boolean);
        if (!replies.length) { res.writeHead(202, CORS); return res.end(); }
        const payload = JSON.stringify(batch ? replies : replies[0]);
        // Clients advertise which framing they can read. Several accept ONLY
        // event-stream on POST, and reply with JSON to those and they stall.
        if (String(req.headers.accept || '').includes('text/event-stream')) {
          res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          return res.end(`event: message\ndata: ${payload}\n\n`);
        }
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        return res.end(payload);
      }

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
          phase: cur.phase || 'grilling',
          build: cur.build || null,
          // The diffs are already inside the review cards; this is the index the
          // page uses to hang "→ built c3" off the decision that caused it.
          changes: (cur.changes || []).map((c) => ({
            id: c.id, title: c.title, because: c.because || [], files: c.files || [],
            reviewId: c.reviewId, rev: c.rev || 1, step: c.step || null,
          })),
          rev: cur.rev || cur.nextId * 1e6 + cur.nextEvent,
          questions: cur.questions,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = await readBody(req);
        const out = recordAnswer(p, body);
        return json(res, out.ok ? 200 : 404, out);
      }

      // One endpoint for every "I can't answer this yet" request. They differ
      // only in what they ask for, so they share a shape rather than each
      // getting a route of its own.
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await readBody(req);
        const out = recordAsk(p, body);
        return json(res, out.ok ? 200 : (out.error === 'unknown kind' ? 400 : 404), out);
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
  };
}

async function serve() {
  const p = statePath();
  // mutate creates the board if it isn't there, under the lock — so a concurrent
  // `add` can win the race to create it without either of them losing anything.
  mutate(p, (cur) => {
    if (args.title) cur.title = args.title;
    if (args.subtitle) cur.subtitle = String(args.subtitle);
    if (args['max-open']) cur.maxOpen = Number(args['max-open']);
    // Persisted so a restart keeps the same URL — otherwise every restart
    // invalidates the link already open on a phone.
    if (args.token) cur.token = args.token === true ? (cur.token || randomToken()) : String(args.token);
    TOKEN = args.token ? cur.token : null;
  });

  const host = args.host || '0.0.0.0';
  const port = await findPort(host, args.port);
  // Claim the voice gateway — the newest board is the one you talk to — but
  // register too, so the others stay reachable by name.
  setCurrent(p);
  registerBoard(p, args.title ? String(args.title) : load(p).title, port);
  const server = createServer(makeHandler(() => p));

  server.listen(port, host, () => {
    const lan = lanAddress();
    const q = TOKEN ? `?t=${TOKEN}` : '';
    const local = `http://localhost:${port}/${q}`;
    const phone = lan && host === '0.0.0.0' ? `http://${lan}:${port}/${q}` : null;
    // Both URLs land in a file next to the state so the caller can read them
    // without waiting on this process's stdout.
    writeFileSync(join(dirname(p), 'url'), phone ? `${local}\n${phone}\n` : `${local}\n`);
    process.stdout.write(`grill-board listening\n`);
    process.stdout.write(`  local  ${local}\n`);
    if (phone) process.stdout.write(`  phone  ${phone}\n`);
    process.stdout.write(`  mcp    http://localhost:${port}/mcp${q}\n`);
    if (TOKEN) process.stdout.write(`  token  ${TOKEN}  (also accepted as: Authorization: Bearer …)\n`);
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
    // A verdict on code is a different job from an answer to a question, and
    // the wake has to say which — one branches a thread, the other rewrites a file.
    if (ev.kind === 'review') {
      const verdict = VERDICTS[(ev.answer.keys || [])[0]] || 'in their own words';
      const from = (ev.because || []).length ? ` from ${ev.because.join(',')}` : '';
      return `[review] ${ev.changeId}${from} — ${verdict}${note}`;
    }
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
      // The board drains twice — once when the questions run out and the build
      // should start, once when every change has a verdict. They call for
      // opposite work, so they are not the same line.
      const reviewed = (s.changes || []).filter((x) => x.reviewId);
      if (s.phase === 'review' && reviewed.length) {
        const tally = { ok: 0, revise: 0, reopen: 0, other: 0 };
        for (const ch of reviewed) {
          const v = verdictOf(s, ch);
          tally[v && tally[v.key] !== undefined ? v.key : 'other']++;
        }
        process.stdout.write(
          `[reviewed] ${tally.ok} accepted, ${tally.revise} to change, ${tally.reopen} to re-decide` +
          `${tally.other ? `, ${tally.other} answered in their own words` : ''}\n`
        );
      } else {
        process.stdout.write(`[drained] board empty — ${c.answered} answered\n`);
      }
      announcedDrain = true;
    }
    await sleep(1000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- build / review cli

const STEP_STATUS = ['pending', 'running', 'done', 'failed'];

function cmdBuild() {
  const p = statePath();
  if (args.step) {
    const status = String(args.status || 'done');
    if (!STEP_STATUS.includes(status)) die(`--status must be one of ${STEP_STATUS.join(', ')}`);
    const out = mutate(p, (s) => {
      ensureWork(s);
      const st = s.build.steps.find((x) => x.id === args.step);
      if (!st) return null;
      st.status = status;
      if (args.note !== undefined) st.note = String(args.note);
      st.at = new Date().toISOString();
      return st;
    });
    if (!out) die(`no build step ${args.step}`);
    process.stdout.write(`${out.id} ${out.status}\n`);
    return;
  }

  const src = args.file === '-' || !args.file ? readFileSync(0, 'utf8') : readFileSync(resolve(args.file), 'utf8');
  let list;
  try { list = JSON.parse(src); } catch (e) { die(`build plan JSON is invalid: ${e.message}`); }
  if (!Array.isArray(list)) list = [list];
  const ids = mutate(p, (s) => {
    ensureWork(s);
    s.phase = 'building';
    s.build.startedAt = s.build.startedAt || new Date().toISOString();
    const added = [];
    for (const raw of list) {
      const title = String(raw.title || '').trim();
      if (!title) continue;
      const id = `s${s.build.steps.length + 1}`;
      s.build.steps.push({
        id, title,
        because: (raw.because || []).map(String),
        status: 'pending', note: raw.note || '', at: null,
      });
      added.push(id);
    }
    return added;
  });
  process.stdout.write(`building — ${ids.length} step${ids.length === 1 ? '' : 's'}: ${ids.join(' ')}\n`);
}

function cmdChange() {
  const p = statePath();
  const src = args.file === '-' || !args.file ? readFileSync(0, 'utf8') : readFileSync(resolve(args.file), 'utf8');
  let list;
  try { list = JSON.parse(src); } catch (e) { die(`changes JSON is invalid: ${e.message}`); }
  if (!Array.isArray(list)) list = [list];
  const out = mutate(p, (s) => logChanges(s, list));
  const bits = [];
  if (out.added.length) bits.push(`logged ${out.added.join(' ')}`);
  if (out.updated.length) bits.push(`rewrote ${out.updated.join(' ')} — their reviews reopened`);
  process.stdout.write(`${bits.join('; ') || 'nothing to log'}\n`);
  // A change with no `because` is one nobody asked for. That is allowed —
  // groundwork exists — but it must be visible rather than quietly unlinked.
  for (const t of out.unlinked) process.stderr.write(`  no "because": ${t}\n`);
}

function cmdReview() {
  const p = statePath();
  const ids = mutate(p, (s) => mintReviews(s));
  const s = load(p);
  process.stdout.write(
    ids.length
      ? `${ids.length} change${ids.length === 1 ? '' : 's'} up for review: ${ids.join(' ')}\n`
      : `nothing new to review (${(s.changes || []).length} change(s) already out)\n`
  );
}

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
  let out =
    `${s.title}  [${s.phase || 'grilling'}]\n` +
    `  open ${c.open} · queued ${c.queued} · answered ${c.answered} · retired ${c.retired}\n` +
    `  threads: ${threads.join(', ')}\n` +
    `  unread events: ${s.events.filter((e) => e.n > (s.cursor || 0)).length}\n`;
  if (s.build && s.build.steps.length) {
    const done = s.build.steps.filter((x) => x.status === 'done').length;
    out += `  build: ${done}/${s.build.steps.length} steps\n`;
    for (const st of s.build.steps) out += `    ${st.status === 'done' ? '✓' : st.status === 'running' ? '◐' : st.status === 'failed' ? '✕' : '·'} ${st.id} ${st.title}\n`;
  }
  if ((s.changes || []).length) {
    out += `  changes: ${s.changes.length}\n`;
    for (const ch of s.changes) {
      const v = verdictOf(s, ch);
      out += `    ${ch.id} ${ch.title}  (${(ch.because || []).join(',') || 'unlinked'}) — ${v ? v.label : ch.reviewId ? 'awaiting review' : 'not sent for review'}\n`;
    }
  }
  process.stdout.write(out);
}

function cmdExport() {
  const s = load(statePath());
  const lines = [`# ${s.title}`, ''];
  if (s.subtitle) lines.push(s.subtitle, '');
  // Review cards are the change log wearing a card, so they are written out
  // under the changes rather than twice.
  const asked = s.questions.filter((q) => q.kind !== 'review');
  const builtFrom = (qid) => (s.changes || []).filter((c) => (c.because || []).includes(qid));
  const threads = [...new Set(asked.map((q) => q.thread))];
  for (const t of threads) {
    lines.push(`## ${t}`, '');
    for (const q of asked.filter((x) => x.thread === t)) {
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
      // The forward link. Reading a decision, you can see what it turned into.
      const built = builtFrom(q.id);
      if (built.length) lines.push(`**Built:** ${built.map((c) => `${c.id} — ${c.title}`).join('; ')}`);
      lines.push('');
    }
  }
  const messages = s.events.filter((e) => e.type === 'message');
  if (messages.length) {
    lines.push('## Notes from the user', '');
    for (const m of messages) lines.push(`- ${m.text}`);
    lines.push('');
  }

  if (s.build && s.build.steps.length) {
    lines.push('## The build', '');
    for (const st of s.build.steps) {
      const mark = { done: 'x', running: '~', failed: '!', pending: ' ' }[st.status] || ' ';
      lines.push(`- [${mark}] **${st.id}** ${st.title}` +
        `${(st.because || []).length ? ` *(${st.because.join(', ')})*` : ''}` +
        `${st.note ? ` — ${st.note}` : ''}`);
    }
    lines.push('');
  }

  if ((s.changes || []).length) {
    lines.push('## What was built', '');
    for (const c of s.changes) {
      lines.push(`### ${c.id} — ${c.title}`, '');
      if (c.rev > 1) lines.push(`*Revision ${c.rev}.*`, '');
      if (c.summary) lines.push(c.summary, '');
      if ((c.files || []).length) lines.push(`**Files** — ${c.files.map((f) => `\`${f}\``).join(', ')}`, '');
      // The back link, and the reason this file is a record rather than a diff
      // dump: every change says which decision it came from and what that
      // decision was, so it can be audited long after the board is gone.
      if ((c.because || []).length) {
        lines.push('**Because you decided**', '');
        for (const qid of (c.because || [])) lines.push(decisionLine(s, qid));
        lines.push('');
      } else {
        lines.push('**Not tied to any question** — groundwork.', '');
      }
      const v = verdictOf(s, c);
      lines.push(`**Review:** ${v ? v.label : c.reviewId ? 'still out' : 'not sent'}${v && v.text ? ` — “${v.text}”` : ''}`, '');
      if (c.diff) {
        const f = fenceFor(c.diff);
        lines.push(`${f}diff`, String(c.diff).replace(/\n+$/, ''), f, '');
      }
    }
  }
  const md = lines.join('\n');
  if (args.out) { writeFileSync(resolve(args.out), md); process.stdout.write(`wrote ${resolve(args.out)}\n`); }
  else process.stdout.write(md);
}

// ---------------------------------------------------------------- dispatch

// A long-lived front door that serves whichever board is CURRENT rather than
// one fixed one. Tunnel this once and register the connector once; every later
// grill is reachable at the same URL. The alternative is re-registering a
// connector every session, which nobody sustains.
async function cmdGateway() {
  const prefs = loadPrefs();
  if (args.token) {
    prefs.gatewayToken = args.token === true ? (prefs.gatewayToken || randomToken()) : String(args.token);
    savePrefs(prefs);
    TOKEN = prefs.gatewayToken;
  }
  const host = args.host || '127.0.0.1';
  const port = await findPort(host, args.port || 7799);
  LOG = true; // a gateway is long-lived and low-traffic; the log is how a connector failure gets diagnosed
  const server = createServer(makeHandler(getCurrent));
  server.listen(port, host, () => {
    const q = TOKEN ? `?t=${TOKEN}` : '';
    process.stdout.write('grill-board gateway listening\n');
    process.stdout.write(`  mcp     http://localhost:${port}/mcp${q}\n`);
    process.stdout.write(`  board   http://localhost:${port}/${q}\n`);
    if (TOKEN) process.stdout.write(`  token   ${TOKEN}\n`);
    process.stdout.write(`  current ${getCurrent() || '(nothing running yet)'}\n`);
    process.stdout.write('  follows whichever board is serving — start one and it appears here.\n');
  });
  await new Promise(() => {});
}

// MCP over stdio, for a second session on this machine — no port, no token,
// no tunnel. The HTTP transport at /mcp is for one that has to reach across a
// network; both call the same handleRpc.
async function cmdMcp() {
  const p = statePath();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      let reply;
      try { reply = handleRpc(p, msg); } catch (e) { reply = rpcErr(msg && msg.id, -32603, e.message); }
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  await new Promise(() => {}); // serve until stdin closes
}

const verbs = {
  serve, add: cmdAdd, new: cmdNew, watch: cmdWatch, retire: cmdRetire,
  note: cmdNote, status: cmdStatus, export: cmdExport, mcp: cmdMcp, gateway: cmdGateway,
  build: cmdBuild, change: cmdChange, review: cmdReview,
};

if (!cmd || !verbs[cmd]) {
  process.stderr.write('usage: board.mjs <serve|add|new|watch|retire|note|status|export|mcp|gateway|build|change|review> --state <path>\n');
  process.exit(1);
}
await verbs[cmd]();

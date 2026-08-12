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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_OPEN = 8;

// The page is re-read from disk on every load, but a `serve` process is not —
// it runs whatever board.mjs was on disk when it started. Boards here run for
// hours while this file is edited, so a server can end up serving a payload the
// page it just handed out no longer understands, and it does it in complete
// silence: the state file has a ten-step build in it, `/api/state` never
// mentions it, and the board looks as if nothing is happening. That is not a
// hypothetical — it is how a whole build went unseen. Bump this whenever
// /api/state gains a field the page depends on.
const API = 3;

// ------------------------------------------------------------- card budget
//
// A card is capped so that answering it does not require skimming it. The cap
// is NOT a brevity rule, and reading it as one produces exactly the wrong card:
// the goal is that one card leaves you holding the whole of ONE thing, so when
// there is more to understand the answer is MORE CARDS, never denser ones.
// Nothing here licenses cutting the table that made a decision decidable —
// that is the cheap way under the limit, and it is the failure this guards
// against. SKILL.md carries the test for what may be cut and what must split.
//
// Two units, deliberately. Paragraphs and figures are what an author can count
// while writing, which is what keeps a refusal rare rather than routine: a
// limit you can only check by running something is a limit you will break.
// Characters catch what a paragraph count cannot — squeeze an author on the
// number of paragraphs and longer paragraphs are the obvious way out.
const MAX_PARAS = 3;
const MAX_FIGURES = 1;
// Whole card, not just the body: title, context, recommendation, and every
// option's label and detail. A field name is not a reason for something to be
// free — with only the body measured, the natural move when refused is to push
// the explanation down into the option details, which is the worst place for
// it (read last, one at a time, never side by side). `spoken` is excluded
// because it is heard rather than read. Measured across a real 15-card board a
// full-shape card ran ~1660 whole, so this leaves headroom and the shape rule
// stays the one an author writes to rather than this number.
const MAX_CHARS = 2000;

// Blocks, not lines: a fenced code block with blank lines inside it is one
// figure, not three paragraphs with two figures around them.
function splitBlocks(md) {
  const out = [];
  let cur = [];
  let fence = null;
  const flush = () => { const t = cur.join('\n').trim(); if (t) out.push(t); cur = []; };
  for (const line of String(md).split('\n')) {
    const f = line.trim().match(/^(```+|~~~+)/);
    if (fence) {
      cur.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; flush(); }
      continue;
    }
    if (f) { flush(); fence = f[1]; cur.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    cur.push(line);
  }
  flush();
  return out;
}

// A figure is a markdown table or a fenced code block — the two shapes that
// carry a tradeoff without prose, and the two an author reaches for when the
// card is genuinely about a comparison.
const isFigure = (b) => /^(```|~~~)/.test(b) || /^\|/.test(b);

function measureCard(raw) {
  const body = String(raw.context || '');
  const blocks = splitBlocks(body);
  const figures = blocks.filter(isFigure).length;
  return {
    paras: blocks.length - figures,
    figures,
    chars:
      String(raw.title || '').length +
      body.length +
      String(raw.recommendation || '').length +
      (raw.options || []).reduce(
        (n, o) => n + String(o.label || '').length + String(o.detail || '').length, 0),
  };
}

// The same budget, on the part of a review card you actually read. The diff is
// NOT counted: it is the artifact under review rather than an explanation of
// it, and a 60-line hunk would refuse every honest change. Nor are the
// decisions quoted onto the card — those come from cards that already passed,
// and refusing a change for someone else's words would be nonsense.
//
// So the teeth for a large change are not a character count. They are the split
// rule: one card per thing you must understand to say yes. A change whose
// summary needs five paragraphs is five changes, and that is what this catches.
// `risk` sits in the recommendation slot on purpose. On a question card the
// recommendation counts toward characters but is not one of the three
// paragraphs, because it is a single trailing statement rather than part of the
// argument — and `risk` is the same shape. Folding it into the body instead
// silently made the real summary budget two paragraphs, not three.
function measureChange(raw) {
  return measureCard({ title: raw.title, context: raw.summary, recommendation: raw.risk });
}

// Not a limit — a nudge, and the number is a judgement rather than a finding.
// Set where a diff stops being something you hold in your head and starts being
// several things wearing one title. An honest single-function rewrite has to
// stay postable, so this never refuses; it only says so on stderr, to the author.
const BIG_DIFF_LINES = 120;

const diffLines = (d) =>
  String(d || '').split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;

// Said in the terms the author can act on — which number, and what it may be.
function overBudget(m) {
  const over = [];
  if (m.paras > MAX_PARAS) over.push(`${m.paras} paragraphs, max ${MAX_PARAS}`);
  if (m.figures > MAX_FIGURES) over.push(`${m.figures} figures, max ${MAX_FIGURES}`);
  if (m.chars > MAX_CHARS) over.push(`${m.chars} characters, max ${MAX_CHARS}`);
  return over;
}

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
    all[p] = { title: title || 'Grill board', port, pid: process.pid, api: API, at: new Date().toISOString() };
    writeFileSync(BOARDS, JSON.stringify(all, null, 2));
  } catch { /* a registry failure must not stop a board */ }
}

// Called after anything the page can only show if the server understands it.
// The write itself always succeeds — the state file is the source of truth —
// so without this the session has no way to know its work is invisible.
function warnStaleServer(p) {
  const b = readRegistry()[p];
  if (!b || !b.pid) return;
  try { process.kill(b.pid, 0); } catch { return; }   // not running; nothing to warn about
  if ((b.api || 0) >= API) return;
  process.stderr.write(
    `  NOTE this board's server (pid ${b.pid}, port ${b.port}) started before this version of\n` +
    `       board.mjs and cannot serve what you just wrote — the page will not show it.\n` +
    `       Restart it:  kill ${b.pid} && node ${join(HERE, 'board.mjs')} serve --state "${p}" --port ${b.port} --adopt &\n`
  );
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
      const val = next === undefined || next.startsWith('--') ? true : (i++, next);
      // Repeats accumulate instead of overwriting, so `--decided X --decided Y`
      // records two decisions rather than losing the first. A flag given once
      // is still a plain string, which is what every existing reader expects.
      if (key in out) out[key] = [...asList(out[key]), val];
      else out[key] = val;
    } else out._.push(a);
  }
  return out;
}

const asList = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v : [v]);

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
    if (q.status !== 'queued' || blocked(s, q)) continue;
    q.status = 'open';
    q.openedAt = new Date().toISOString();
    open++;
  }
}

// A card may declare `needs: ["q4"]` — it stays off the board until q4 is
// answered. Opt-in per card, and used only where the second question genuinely
// has no meaning until the first is settled: gating a card that could have been
// answered just hides a question the user was ready for, which is the blocking
// this whole board exists to remove. It reuses `queued` rather than adding a
// third status, so the header's "N queued" already counts it.
//
// Two deliberate non-blockers. An id that matches nothing does NOT gate — a
// typo has to degrade to an ungated card rather than one that is invisible for
// ever, and invisible-for-ever is unfindable from the page. Nor does a RETIRED
// dependency: it is settled, just not by an answer, and waiting on it would
// strand every follow-up of a card the agent re-asked.
function blocked(s, q) {
  return (q.needs || []).some((id) => {
    const dep = s.questions.find((x) => x.id === id);
    return dep && (dep.status === 'open' || dep.status === 'queued');
  });
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
      // Ids this card waits on. Ordering inside a nest is already depth-first,
      // so this is only for the case ordering cannot cover: a question whose
      // premise is still open, which the user would have to read and skip.
      needs: (raw.needs || []).map(String),
      status: 'open',
      askedAt: new Date().toISOString(),
      openedAt: null,
      answer: null,
      retiredReason: null,
    };
    if (!q.title) continue;
    // Parked deliberately (`queued`), or waiting on something still open. Both
    // land in the same state; `promote` releases whichever becomes eligible.
    q.status = raw.queued || blocked(s, q) ? 'queued' : 'open';
    q.openedAt = q.status === 'open' ? new Date().toISOString() : null;
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
  if (!s.workers) s.workers = {};
  if (!s.cursors) s.cursors = {};
  return s;
}

// ------------------------------------------------------------- who is here
// A build can be shared by several agents, so every write carries a name. An
// unattributed change is one nobody can be asked about later — and with three
// agents on one board, "who decided to do it that way" stops being rhetorical.
//
// The host session id distinguishes separate Claude Code sessions for free, but
// subagents inside ONE session all inherit it — so it can only ever be a
// fallback. Anything that takes work has to say who it is out loud.
function whoami({ required = false } = {}) {
  const explicit = args.as && args.as !== true ? String(args.as).trim().slice(0, 24) : null;
  if (explicit) return explicit;
  if (required) die('missing --as <name> — every agent sharing a board needs one');
  const host = process.env.CLAUDE_CODE_HOST_SESSION_ID || '';
  return host ? `s-${host.replace(/^local[-_]/, '').slice(0, 6)}` : 'anon';
}

function touchWorker(s, name, patch = {}) {
  ensureWork(s);
  let w = s.workers[name];
  if (!w) {
    // A worker joining mid-build was not here for what already happened, so its
    // event cursor starts at the end. Starting at 0 would replay the entire
    // grill into an agent that only came to write one file.
    const last = s.events.length ? s.events[s.events.length - 1].n : 0;
    w = s.workers[name] = { firstSeen: new Date().toISOString(), note: '' };
    if (s.cursors[name] === undefined) s.cursors[name] = last;
  }
  w.lastSeen = new Date().toISOString();
  Object.assign(w, patch);
  return w;
}

const minutesSince = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null);

// A step is takeable when nothing it depends on is outstanding and no one else
// is holding it. `needs` is what makes the fan-out correct rather than merely
// concurrent: without it an agent cheerfully claims "write the regression test"
// while the fix it tests is still being written.
function blockersFor(steps, st) {
  return (st.needs || []).filter((id) => {
    const dep = steps.find((x) => x.id === id);
    return !dep || dep.status !== 'done';
  });
}

function takeable(steps, st) {
  return st.status === 'pending' && !st.owner && blockersFor(steps, st).length === 0;
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
  // Calls the agent made that no answer covers. These are the ones most worth a
  // second pair of eyes precisely because nobody was asked — a review that shows
  // only what was decided ON THE BOARD hides everything decided off it.
  const st = c.step && s.build ? s.build.steps.find((x) => x.id === c.step) : null;
  if (st && (st.decided || []).length) {
    out.push('**Also decided while building** — nobody asked about these', '');
    for (const d of st.decided) out.push(`- ${d.text}`);
    out.push('');
  }
  if (st && (st.flags || []).length) {
    for (const f of st.flags) out.push(`⚑ ${f.text}`, '');
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

function logChanges(s, list, author) {
  ensureWork(s);
  if (author) touchWorker(s, author);
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
      // Who wrote it. A rewrite can land with a different author than the
      // original — that is fine and worth seeing, so it is not pinned.
      author: author || raw.author || null,
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
    // `changeId` is what routes this to the agent who wrote the change when a
    // build is shared. Asking a review card to be re-said is a job for whoever
    // knows the code, not for whoever happens to be leading.
    pushEvent(cur, { type: 'ask', kind, id: q.id, thread: q.thread, title: q.title, changeId: q.changeId || null });
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
          api: API,
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
            reviewId: c.reviewId, rev: c.rev || 1, step: c.step || null, author: c.author || null,
            at: c.at || null,
          })),
          workers: cur.workers || {},
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
  // Two grills on the same subject the same day derive the same state path, and
  // the result used to be silent: both bound a port, both served ONE file, the
  // later title won and each URL showed the other's questions merged in. Several
  // agents sharing a board on purpose is the whole point of `--as`; two
  // unrelated grills colliding by accident is not, and it has to be loud.
  if (!args.adopt && existsSync(p)) {
    const prior = peek(p);
    const live = readRegistry()[p];
    let alive = false;
    try { alive = !!(live && live.pid) && (process.kill(live.pid, 0), true); } catch { alive = false; }
    if (alive && prior && args.title && String(args.title) !== prior.title) {
      die(`"${prior.title}" is already running on this exact state path (pid ${live.pid}, port ${live.port}).\n` +
          `  Two different grills would merge into one board.\n` +
          `  Use a different --state path, or --adopt to join that board on purpose.`);
    }
  }
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

  // Measured before anything is written. An over-budget card is refused and the
  // REST OF THE BATCH STILL LANDS: the batch is a transport detail, not a unit
  // of meaning, and one careless card costing three rewrites is how a rule
  // becomes something you route around. Untitled entries are dropped as before,
  // and are excluded here so the ids below pair with the cards that produced them.
  const titled = list.filter((raw) => String(raw?.title || '').trim());
  const ok = [];
  const bad = [];
  for (const raw of titled) {
    const m = measureCard(raw);
    const over = overBudget(m);
    (over.length ? bad : ok).push({ raw, m, over });
  }

  const added = ok.length ? mutate(p, (s) => addQuestions(s, ok.map((c) => c.raw))) : [];
  const after = load(p);
  const open = after.questions.filter((q) => q.status === 'open').length;
  const queued = after.questions.filter((q) => q.status === 'queued').length;
  process.stdout.write(`added ${added.length}: ${added.join(' ')} — ${open} open, ${queued} queued\n`);
  // Every accepted card reports where it landed. This is the answer to "how do
  // I know the limit before I hit it" — a `measure` verb would only help an
  // author who remembered to run it, and the author who forgets is the same one
  // who writes the long card. Printed on success, it calibrates continuously.
  for (let i = 0; i < added.length; i++) {
    const m = ok[i].m;
    process.stdout.write(
      `  ${added[i].padEnd(4)} ${m.paras}p ${m.figures}f ${String(m.chars).padStart(4)}c\n`);
  }

  if (!bad.length) return;
  process.stderr.write(
    `\n  ${bad.length} card${bad.length > 1 ? 's' : ''} REFUSED — the rest landed.\n`);
  for (const c of bad) {
    process.stderr.write(`    "${String(c.raw.title).slice(0, 56)}"\n      ${c.over.join(' · ')}\n`);
  }
  process.stderr.write(
    `\n  A card over budget is a card with more than one thing in it. Split it: post the\n` +
    `  first decision, then the rest as follow-ups with "parentId" set to it. There is no\n` +
    `  cap on how many — a decision with six parts is six cards.\n` +
    `  Do NOT get under the limit by cutting the table or the option costs. That is the\n` +
    `  cheap way under and it removes what made the card decidable, which is the failure\n` +
    `  the budget exists to prevent.\n` +
    `  You may also revise the cards that just landed — retire them and re-post with the\n` +
    `  same parentId; splitting one card usually leaves its siblings overlapping.\n`);
  process.exitCode = 1;
}

function cmdNew() {
  const p = statePath();
  // The cursor is per agent. One shared cursor was fine while one agent drained
  // the board; with several it is a race where whoever calls `new` first
  // swallows everyone else's wake and the others are told nothing happened.
  const me = args.as ? whoami() : null;
  const out = mutate(p, (s) => {
    const last = s.events.length ? s.events[s.events.length - 1].n : 0;
    if (!me) {
      const fresh = s.events.filter((e) => e.n > (s.cursor || 0));
      s.cursor = last;
      return fresh;
    }
    ensureWork(s);
    touchWorker(s, me); // seeds this worker's cursor at `last` if it is new here
    const from = s.cursors[me] ?? 0;
    const fresh = s.events.filter((e) => e.n > from).filter((e) => (args.mine ? forWorker(s, e, me) : true));
    s.cursors[me] = last;
    return fresh;
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// Is this event this worker's business? Anything about a change — a verdict on
// it, or a request to re-say its review card — belongs to whoever wrote it.
// Messages are addressed to everyone. Everything else is the lead's: a worker
// woken by an answer to q7 has no idea what to do with it.
function forWorker(s, ev, me) {
  if (ev.type === 'message') return true;
  if (ev.changeId) {
    const c = (s.changes || []).find((x) => x.id === ev.changeId);
    return !c || !c.author || c.author === me;
  }
  return false;
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
  // A step landing is the lead's wake, and the line carries the handback rather
  // than pointing at it — the lead should not have to run a second command, let
  // alone open the diff, to find out what its worker settled on.
  if (ev.type === 'step') {
    const head = `[step] ${ev.id} ${ev.status}${ev.by ? ` by ${ev.by}` : ''} — ${ev.title}` +
      `${ev.note ? ` (${ev.note})` : ''}${(ev.changes || []).length ? ` · ${ev.changes.join(' ')}` : ''}`;
    const body = [
      ...(ev.decided || []).map((d) => `    decided: ${d}`),
      ...(ev.flags || []).map((f) => `    FLAG: ${f}`),
    ];
    return [head, ...body].join('\n');
  }
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
  // `--mine` is what stops N agents all waking on one verdict meant for one of
  // them. Without it every worker's Monitor fires on every event on the board.
  const me = args.as ? whoami() : null;
  const only = me && args.mine;
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
      // Still resets the drain latch even when filtered out — the board did move,
      // and a later `[drained]` has to be allowed to fire again.
      announcedDrain = false;
      if (only && !forWorker(s, ev, me)) continue;
      process.stdout.write(describe(ev) + '\n');
    }
    const c = counts(s);
    // "The board is empty" is a signal for whoever runs the board, not for the
    // five workers on it — each of which would otherwise wake to be told about
    // work that is not theirs. A worker wakes for verdicts on what it wrote.
    if (!only && c.open === 0 && c.queued === 0 && s.questions.length && !announcedDrain) {
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
    const decided = asList(args.decided).map(String);
    const flags = asList(args.flag).map(String);
    // Recording a decision is not finishing the work. A worker settles on
    // something an hour into a step and says so THEN — if that call also marked
    // the step done, it would either be delayed until the end (when the reason
    // has faded) or end the step early. So the status only moves when asked.
    const moving = args.status !== undefined || (!decided.length && !flags.length);
    const status = String(args.status || 'done');
    if (!STEP_STATUS.includes(status)) die(`--status must be one of ${STEP_STATUS.join(', ')}`);
    const me = whoami();
    const out = mutate(p, (s) => {
      ensureWork(s);
      const st = s.build.steps.find((x) => x.id === args.step);
      if (!st) return null;
      // Only the holder moves a claimed step. A single-agent build claims
      // nothing and owns nothing, so it passes straight through — the check
      // only bites once someone has actually taken the work.
      if (st.owner && st.owner !== me && !args.force) {
        return { denied: `${st.id} is held by ${st.owner} — claim it, or pass --force` };
      }
      touchWorker(s, me);
      // What this agent settled that the plan did not settle for it, and what
      // it wants someone else to know. This is the whole point of the handback:
      // a lead that fans six steps out to six agents otherwise learns what they
      // each decided only by reading their code back, which costs more than
      // doing the step. Appended, never replaced — a decision made at minute
      // ten and one made at minute fifty are both true.
      if (decided.length) st.decided = [...(st.decided || []), ...decided.map((t) => ({ by: me, at: new Date().toISOString(), text: t }))];
      if (flags.length) st.flags = [...(st.flags || []), ...flags.map((t) => ({ by: me, at: new Date().toISOString(), text: t }))];
      if (args.note !== undefined) st.note = String(args.note);
      if (!moving) return { ...st, recorded: decided.length + flags.length, moved: false, minted: [] };
      st.status = status;
      st.at = new Date().toISOString();
      // Finishing or failing hands the step back; the holder is kept for the
      // record, but `owner` is what "someone is on this right now" means.
      if (status === 'done' || status === 'failed') { st.doneBy = st.owner || me; st.owner = null; }
      // Marking the last step settled ends the build, so the changes go up for
      // review here rather than waiting for someone to remember `review`. The
      // promise the board makes — "every change comes back to you" — cannot be
      // one more thing the session has to do; a build that finishes silently
      // with eight unreviewed changes is exactly what it was built to prevent.
      const settled = s.build.steps.every((x) => x.status === 'done' || x.status === 'failed');
      // With nothing logged there is nothing to review, and flipping the phase
      // would put "Everything reviewed" on a board that has been shown no code
      // at all — worse than the silence it replaces. So that case stays in
      // `building` and is reported as the debt it is.
      const logged = s.changes.filter((c) => c.title).length;
      const minted = settled && logged ? mintReviews(s) : [];
      // The lead is not watching this board — it is waiting on an event stream.
      // Without this, a fanned-out build reaches it as silence: no wake when a
      // step lands, so the only way to find out is to poll, and the only way to
      // find out WHAT was decided is to read the diff. The handback rides along
      // so `new` answers both questions in one go.
      if (status === 'done' || status === 'failed') {
        pushEvent(s, {
          type: 'step', id: st.id, status, by: st.doneBy, title: st.title,
          note: st.note || '', decided: (st.decided || []).map((d) => d.text),
          flags: (st.flags || []).map((f) => f.text),
          changes: s.changes.filter((c) => c.step === st.id).map((c) => c.id),
        });
      }
      return { ...st, minted, moved: true, owed: settled && !logged };
    });
    if (!out) die(`no build step ${args.step}`);
    if (out.denied) die(out.denied);
    if (!out.moved) {
      process.stdout.write(`${out.id} — recorded ${out.recorded} (status unchanged: ${out.status})\n`);
      warnStaleServer(p);
      return;
    }
    process.stdout.write(`${out.id} ${out.status}\n`);
    // Only on a shared build. Alone, the agent that decided it is the agent
    // reading this, and there is nobody to hand back to.
    if ((status === 'done' || status === 'failed') && !(out.decided || []).length && Object.keys(load(p).workers || {}).length > 1) {
      process.stderr.write(`  ${out.id} settled with no --decided: whoever picks this up next cannot tell what you chose\n`);
    }
    if (out.minted.length) {
      process.stdout.write(`build finished — ${out.minted.length} change${out.minted.length === 1 ? '' : 's'} up for review: ${out.minted.join(' ')}\n`);
    }
    warnStaleServer(p);
    if (out.owed) {
      process.stdout.write('every step is settled and NO change has been logged — there is nothing to review.\n' +
        '  Log what you wrote with `change`, one entry per change, each naming the questions behind it.\n');
    }
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
        // What must be done first, and what this step expects to touch. Both are
        // read by `claim`: the first to decide whether the step is takeable at
        // all, the second to warn when two agents are heading for one file.
        needs: (raw.needs || []).map(String),
        files: (raw.files || []).map(String),
        status: 'pending', note: raw.note || '', at: null,
        owner: null, claimedAt: null,
      });
      added.push(id);
    }
    return added;
  });
  process.stdout.write(`building — ${ids.length} step${ids.length === 1 ? '' : 's'}: ${ids.join(' ')}\n`);
  warnStaleServer(p);
}

// Take one step, exclusively. This is the whole concurrency story: the pick and
// the mark happen inside the same lock as every other write, so two agents
// racing for the last step cannot both win it.
function cmdClaim() {
  const p = statePath();
  const me = whoami({ required: true });
  const out = mutate(p, (s) => {
    ensureWork(s);
    touchWorker(s, me, args.note !== undefined ? { note: String(args.note) } : {});
    const steps = s.build.steps;
    if (!steps.length) return { ok: false, why: 'no build plan yet' };

    const target = args.steal && args.steal !== true ? String(args.steal) : args.step && args.step !== true ? String(args.step) : null;
    let st;
    if (target) {
      st = steps.find((x) => x.id === target);
      if (!st) return { ok: false, why: `no step ${target}` };
      if (st.status === 'done') return { ok: false, why: `${target} is already done` };
      if (st.owner && st.owner !== me && !args.steal) {
        return { ok: false, why: `${target} is held by ${st.owner} (${minutesSince(st.claimedAt)}m) — pass --steal ${target} to take it anyway`, held: true };
      }
      const blocked = blockersFor(steps, st);
      if (blocked.length && !args.steal) return { ok: false, why: `${target} waits on ${blocked.join(', ')}` };
    } else {
      st = steps.find((x) => takeable(steps, x));
      if (!st) {
        const left = steps.filter((x) => x.status !== 'done');
        if (!left.length) return { ok: false, why: 'every step is done', drained: true };
        const held = left.filter((x) => x.owner).map((x) => `${x.id}→${x.owner}`);
        const waiting = left.filter((x) => !x.owner).map((x) => `${x.id} waits on ${blockersFor(steps, x).join(',')}`);
        return { ok: false, why: `nothing takeable right now. ${[...held, ...waiting].join('; ')}` };
      }
    }

    const stolenFrom = st.owner && st.owner !== me ? st.owner : null;
    // A file two live steps both expect to touch is the one thing this queue
    // cannot make safe, so it says so rather than pretending. Plans guess at
    // their file lists, which is why this warns instead of refusing.
    const mine = new Set(st.files || []);
    const overlap = steps
      .filter((x) => x.id !== st.id && x.status === 'running' && x.owner)
      .flatMap((x) => (x.files || []).filter((f) => mine.has(f)).map((f) => `${f} (also ${x.id}, ${x.owner})`));

    st.owner = me;
    st.status = 'running';
    st.claimedAt = new Date().toISOString();
    st.at = st.claimedAt;
    if (stolenFrom) st.stolenFrom = stolenFrom;
    return { ok: true, step: st, stolenFrom, overlap };
  });

  if (!out.ok) {
    process.stdout.write(`${out.why}\n`);
    // Nothing left is a normal end to a worker loop, not a failure. Everything
    // else is: exiting 0 on "someone else holds it" makes a loop spin forever.
    process.exit(out.drained ? 0 : 3);
  }
  process.stdout.write(`${out.step.id} ${out.step.title}\n`);
  if ((out.step.because || []).length) process.stdout.write(`  because ${out.step.because.join(' ')}\n`);
  if ((out.step.files || []).length) process.stdout.write(`  files   ${out.step.files.join(' ')}\n`);
  if (out.stolenFrom) process.stderr.write(`  TAKEN FROM ${out.stolenFrom} — make sure they really stopped\n`);
  for (const o of out.overlap) process.stderr.write(`  OVERLAP ${o}\n`);
}

function cmdRelease() {
  const p = statePath();
  const me = whoami({ required: true });
  const id = args.step && args.step !== true ? String(args.step) : null;
  const out = mutate(p, (s) => {
    ensureWork(s);
    touchWorker(s, me);
    const held = s.build.steps.filter((x) => x.owner === me && (!id || x.id === id));
    if (!held.length) return { ok: false, why: id ? `you do not hold ${id}` : 'you hold nothing' };
    for (const st of held) {
      st.owner = null;
      st.claimedAt = null;
      st.status = args.failed ? 'failed' : 'pending';
      // Giving a step back leaves no trace on purpose — the next agent to take
      // it is the one who did it. Failing it is a fact about a person's
      // attempt, so that one is signed.
      if (args.failed) st.doneBy = me;
      if (args.reason) st.note = String(args.reason);
      st.at = new Date().toISOString();
    }
    return { ok: true, ids: held.map((x) => x.id) };
  });
  if (!out.ok) die(out.why);
  process.stdout.write(`released ${out.ids.join(' ')}${args.failed ? ' (failed)' : ''}\n`);
}

// Everything the workers settled, in one screen. The event stream is the live
// channel — this is the standing one, for a lead that has just picked the board
// up, or is about to write the summary and needs the whole build at once.
//
// A step with nothing recorded says so rather than being omitted. Silence that
// looks like "no decisions" is the failure this exists to prevent: the lead
// needs to know which steps it still has to read back, and which it does not.
function cmdDecisions() {
  const p = statePath();
  const s = load(p);
  const steps = s.build ? s.build.steps : [];
  if (!steps.length) return process.stdout.write('no build yet\n');
  const only = args.step && args.step !== true ? String(args.step) : null;
  const mine = args.as ? whoami() : null;
  const out = [];
  let bare = 0;
  for (const st of steps) {
    if (only && st.id !== only) continue;
    const who = st.doneBy || st.owner;
    if (mine && who !== mine) continue;
    const decided = st.decided || [], flags = st.flags || [];
    const changes = (s.changes || []).filter((c) => c.step === st.id);
    // Nothing recorded and nothing done yet is not a gap — it has not happened.
    const settled = st.status === 'done' || st.status === 'failed';
    if (settled && !decided.length) bare++;
    out.push(`${st.id}  ${st.title}  [${st.status}${who ? ` · ${who}` : ''}]${st.note ? ` — ${st.note}` : ''}`);
    for (const c of changes) out.push(`    wrote    ${c.id} ${(c.files || []).join(' ') || c.title}`);
    for (const d of decided) out.push(`    decided  ${d.text}`);
    for (const f of flags) out.push(`    FLAG     ${f.text}`);
    if (settled && !decided.length) out.push('    decided  — nothing recorded; you would have to read this one back');
  }
  process.stdout.write(out.join('\n') + '\n');
  if (bare) process.stderr.write(`\n  ${bare} settled step(s) recorded no decisions.\n`);
}

function cmdChange() {
  const p = statePath();
  const src = args.file === '-' || !args.file ? readFileSync(0, 'utf8') : readFileSync(resolve(args.file), 'utf8');
  let list;
  try { list = JSON.parse(src); } catch (e) { die(`changes JSON is invalid: ${e.message}`); }
  if (!Array.isArray(list)) list = [list];
  const me = whoami();

  // A review card is a card. Its prose obeys the same budget, for the same
  // reason: a change you approve without understanding is the expensive version
  // of the skimmed question — you find out weeks later, and you own the code.
  const titled = list.filter((raw) => String(raw?.title || '').trim());
  const ok = [], bad = [];
  for (const raw of titled) {
    const over = overBudget(measureChange(raw));
    (over.length ? bad : ok).push({ raw, over });
  }

  const out = ok.length
    ? mutate(p, (s) => logChanges(s, ok.map((c) => c.raw), me))
    : { added: [], updated: [], unlinked: [] };
  const bits = [];
  if (out.added.length) bits.push(`logged ${out.added.join(' ')} as ${me}`);
  if (out.updated.length) bits.push(`rewrote ${out.updated.join(' ')} — their reviews reopened`);
  process.stdout.write(`${bits.join('; ') || 'nothing to log'}\n`);
  // A change with no `because` is one nobody asked for. That is allowed —
  // groundwork exists — but it must be visible rather than quietly unlinked.
  for (const t of out.unlinked) process.stderr.write(`  no "because": ${t}\n`);

  for (const c of ok) {
    const n = diffLines(c.raw.diff);
    if (n > BIG_DIFF_LINES) {
      process.stderr.write(
        `  ${n}-line diff: "${String(c.raw.title).slice(0, 52)}"\n` +
        `    Not refused — but a diff this size is usually more than one thing, and each\n` +
        `    thing wants its own card. Split it if it is; ignore this if it genuinely is not.\n`);
    }
  }

  if (bad.length) {
    process.stderr.write(
      `\n  ${bad.length} change${bad.length > 1 ? 's' : ''} REFUSED — the rest logged.\n`);
    for (const c of bad) {
      process.stderr.write(`    "${String(c.raw.title).slice(0, 56)}"\n      ${c.over.join(' · ')}\n`);
    }
    process.stderr.write(
      `\n  Measured on "title + summary + risk" only — the diff and the quoted decisions do\n` +
      `  not count. So this is not "write less about it": a summary that needs more than\n` +
      `  ${MAX_PARAS} paragraphs is describing more than one thing, and the fix is to LOG IT AS MORE\n` +
      `  THAN ONE CHANGE — one per thing the reader must understand to say yes. Past three,\n` +
      `  add a parent change saying how they fit.\n`);
    process.exitCode = 1;
  }
  warnStaleServer(p);
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
  warnStaleServer(p);
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
  const workers = Object.entries(s.workers || {});
  if (workers.length) {
    out += `  agents: ${workers.length}\n`;
    for (const [name, w] of workers) {
      const holding = (s.build ? s.build.steps : []).filter((x) => x.owner === name).map((x) => x.id);
      out += `    ${name} — ${holding.length ? `on ${holding.join(',')}` : 'idle'}, last seen ${minutesSince(w.lastSeen)}m ago${w.note ? ` · ${w.note}` : ''}\n`;
    }
  }
  if (s.build && s.build.steps.length) {
    const done = s.build.steps.filter((x) => x.status === 'done').length;
    out += `  build: ${done}/${s.build.steps.length} steps\n`;
    for (const st of s.build.steps) {
      const mark = st.status === 'done' ? '✓' : st.status === 'running' ? '◐' : st.status === 'failed' ? '✕' : '·';
      const who = st.owner ? `  ← ${st.owner} (${minutesSince(st.claimedAt)}m)` : st.doneBy ? `  ${st.doneBy}` : '';
      const waits = blockersFor(s.build.steps, st);
      out += `    ${mark} ${st.id} ${st.title}${who}${waits.length && st.status === 'pending' ? `  waits on ${waits.join(',')}` : ''}\n`;
    }
  }
  if ((s.changes || []).length) {
    out += `  changes: ${s.changes.length}\n`;
    for (const ch of s.changes) {
      const v = verdictOf(s, ch);
      out += `    ${ch.id} ${ch.title}  (${(ch.because || []).join(',') || 'unlinked'})${ch.author ? ` by ${ch.author}` : ''} — ${v ? v.label : ch.reviewId ? 'awaiting review' : 'not sent for review'}\n`;
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
      const who = st.doneBy || st.owner;
      lines.push(`- [${mark}] **${st.id}** ${st.title}` +
        `${(st.because || []).length ? ` *(${st.because.join(', ')})*` : ''}` +
        `${who ? ` — ${who}` : ''}${st.note ? ` — ${st.note}` : ''}`);
      // The record is the thing you keep, and six months on "why is it matched
      // on lemma" is answered here or nowhere — the agent that knew is gone.
      for (const d of st.decided || []) lines.push(`  - decided: ${d.text}`);
      for (const f of st.flags || []) lines.push(`  - ⚑ ${f.text}`);
    }
    lines.push('');
  }

  if ((s.changes || []).length) {
    lines.push('## What was built', '');
    for (const c of s.changes) {
      lines.push(`### ${c.id} — ${c.title}`, '');
      if (c.author) lines.push(`*Written by ${c.author}.*${c.rev > 1 ? ` *Revision ${c.rev}.*` : ''}`, '');
      else if (c.rev > 1) lines.push(`*Revision ${c.rev}.*`, '');
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
  claim: cmdClaim, release: cmdRelease, decisions: cmdDecisions,
};

// The counter, exported so a test can run the SHIPPED one over SKILL.md's
// worked examples. Agents copy the shape of an example far more reliably than
// they follow the rule written above it, so an example that quietly drifts over
// budget teaches the wrong card to everyone who reads it — and nothing else
// would notice, because SKILL.md is prose and prose does not fail a build.
export { measureCard, measureChange, overBudget, MAX_PARAS, MAX_FIGURES, MAX_CHARS };

// Importing this file must not run a verb. Everything above is definitions; the
// dispatch below is the only thing that acts, and it is gated on being the
// process entry point rather than an import.
//
// Compared through realpath on BOTH sides, because this skill is normally
// reached through a symlink (~/.claude/skills → ~/.agents/skills). Node
// realpaths the main entry but not `import.meta.url`'s spelling, so a plain
// string compare silently decides "this is an import" and every CLI call
// becomes a no-op that exits 0 — measured: 42 of 53 checks failed with no error.
const isMain = (() => {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  if (!cmd || !verbs[cmd]) {
    process.stderr.write(
      'usage: board.mjs <serve|add|new|watch|retire|note|status|export|mcp|gateway|build|change|review|claim|release|decisions> --state <path>\n' +
      '       agents sharing one board pass --as <name> to claim, log and drain independently\n' +
      '       `decisions` is the lead\'s read: what every worker settled, without opening a diff\n'
    );
    process.exit(1);
  }
  await verbs[cmd]();
}

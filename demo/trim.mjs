#!/usr/bin/env node
// Turns a real board's state file into demo/state.json.
//
//   node demo/trim.mjs ~/.claude/grill-board/<board>/state.json
//
// It emits exactly the payload `GET /api/state` emits, because that is the only
// shape the page knows how to read — anything else is a demo that renders
// almost right. Two things get stripped and both matter: the board's TOKEN,
// which must never reach a public page, and absolute paths, which carry a home
// directory nobody needs to see.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { process.stderr.write('usage: node demo/trim.mjs <state.json>\n'); process.exit(1); }

const cur = JSON.parse(readFileSync(src, 'utf8'));

// `api` is pinned to what the source board reported so the page's stale-server
// banner stays quiet. A demo that opens with "this board's server is older than
// this page" is a demo that reports itself broken.
const out = {
  api: cur.api || 4,
  boardId: 'demo',
  prefs: {},
  title: cur.title,
  subtitle: cur.subtitle,
  agentNote: cur.agentNote,
  agentNoteAt: cur.agentNoteAt,
  maxOpen: Math.max(cur.maxOpen || 8, (cur.questions || []).length),
  phase: cur.phase || 'grilling',
  build: cur.build || null,
  changes: (cur.changes || []).map((c) => ({
    id: c.id, title: c.title, because: c.because || [], files: c.files || [],
    reviewId: c.reviewId, rev: c.rev || 1, step: c.step || null, author: c.author || null,
    at: c.at || null,
  })),
  workers: cur.workers || {},
  // Frozen. The page re-renders only when this changes, which is exactly why a
  // click sticks instead of being reverted by the next poll.
  rev: 1,
  questions: cur.questions || [],
};

const home = process.env.HOME || '';
let text = JSON.stringify(out, null, 1);
if (home) text = text.split(home).join('~');
if (cur.token) text = text.split(cur.token).join('DEMO');
writeFileSync(join(HERE, 'state.json'), text + '\n');

const open = out.questions.filter((q) => q.status === 'open').length;
process.stdout.write(
  `demo/state.json — ${out.questions.length} cards (${open} open), ` +
  `${out.changes.length} changes, phase ${out.phase}\n`
);
if (cur.token) process.stderr.write('  (token scrubbed)\n');

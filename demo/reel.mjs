#!/usr/bin/env node
// Builds the frames for the README's GIF, by REPLAYING a real board.
//
//   node demo/reel.mjs <state.json> [outdir]
//
// q12 settled that the demo and the GIF do different jobs: the demo proves the
// board is real, and only the GIF can show that cards ARRIVE WHILE YOU ANSWER —
// a claim about time, which no still image can carry.
//
// So the frames are not invented. Each one is the same board at a different
// moment: cards un-answered and removed to wind it back, then let forward one
// beat at a time. Every word in it was really written and really answered.
//
// Frames render through build.mjs's `render`, so the GIF and the demo cannot
// disagree about what the page looks like.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { process.stderr.write('usage: node demo/reel.mjs <state.json> [outdir]\n'); process.exit(1); }
const OUT = resolve(process.argv[3] || join(HERE, 'reel'));

const cur = JSON.parse(readFileSync(src, 'utf8'));
const qs = cur.questions || [];
const steps = (cur.build && cur.build.steps) || [];

// One frame = how many cards exist, how many of those are answered, and where
// the build has got to. Winding a card back to `open` is just dropping its
// answer — the card itself is untouched, which is why the text stays real.
const shot = (nCards, nAnswered, phase, nSteps) => {
  const questions = qs.slice(0, nCards).map((q, i) => (i < nAnswered ? q : {
    ...q, status: 'open', answer: null, ask: null,
  }));
  const build = phase === 'grilling' ? null : {
    ...cur.build,
    steps: steps.map((st, i) => (i < nSteps
      ? st
      : { ...st, status: 'pending', at: null, note: '', decided: [], flags: [], owner: null, doneBy: null })),
    approvedAt: phase === 'planned' ? null : (cur.build || {}).approvedAt,
  };
  return {
    api: cur.api || 4, boardId: 'reel', prefs: {},
    title: cur.title, subtitle: cur.subtitle,
    agentNote: null, agentNoteAt: null,
    maxOpen: Math.max(8, nCards),
    phase, build,
    changes: phase === 'grilling' || phase === 'planned' ? [] : (cur.changes || []).slice(0, nSteps),
    workers: {}, rev: 1, questions,
  };
};

// The beat sheet. Held frames at the moments that carry the argument — the
// board filling up, and the plan sitting there waiting to be started.
const FRAMES = [
  ['grilling', 3, 0, 0], ['grilling', 3, 0, 0],
  ['grilling', 3, 1, 0],
  ['grilling', 6, 2, 0],            // <- answering one made three more appear
  ['grilling', 6, 2, 0],
  ['grilling', 9, 4, 0],
  ['grilling', 11, 7, 0],
  ['grilling', 14, 11, 0],
  ['grilling', 16, 16, 0],
  ['planned', 16, 16, 0], ['planned', 16, 16, 0],   // the button, held
  ['building', 16, 16, 2],
  ['building', 16, 16, 4],
  ['building', 16, 16, 6],
  ['building', 16, 16, steps.length],
  ['building', 16, 16, steps.length],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
FRAMES.forEach(([phase, nCards, nAns, nSteps], i) => {
  const html = render(shot(nCards, nAns, phase, nSteps), { ribbon: false });
  writeFileSync(join(OUT, `f${String(i).padStart(2, '0')}.html`), html);
});
process.stdout.write(`${FRAMES.length} frames in ${OUT}\n`);

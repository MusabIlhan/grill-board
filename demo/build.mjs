#!/usr/bin/env node
// Generates demo/index.html from the REAL board.html plus a frozen state.
//
// The point is that there is no second copy of the page to keep in step. The
// demo is board.html with two <script> tags and a stylesheet injected, and
// `--check` re-runs the generation and fails if the committed output has
// drifted — so a change to board.html that nobody regenerated is a red test,
// not a demo that quietly shows last month's board.
//
//   node demo/build.mjs            write demo/index.html
//   node demo/build.mjs --check    exit 1 if it is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

// The state a visitor sees. `trim.mjs` produces it from a real board — an
// invented one reads as invented, because the cards come out too tidy and the
// diffs stop looking like diffs.
const state = JSON.parse(read('state.json'));

// JSON.stringify does NOT escape `</script>`, and the moment a review card
// quotes this very file the state contains that literal — at which point the
// browser closes the tag mid-object and the page renders an empty board with an
// offline banner. It shipped exactly once, for about ten minutes. `\u003c` is a
// plain JS escape for `<`, so the value is unchanged and the tag cannot end
// early.
const embed = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// Exported so `reel.mjs` renders its frames through the SAME path the demo
// uses. Two renderers would drift, and the one that drifted would be the one
// nobody looks at until it is in a README.
export function render(st, { ribbon = true } = {}) {
  const page = readFileSync(join(HERE, '..', 'board.html'), 'utf8');
  const marker = '</head>';
  if (!page.includes(marker)) throw new Error('board.html has no </head> to inject before');

  // Order matters and is the whole correctness argument: the state, then the
  // shim that closes over it, then the page's own script — which polls on its
  // first tick and must find `fetch` already replaced.
  const inject =
    (ribbon ? `<style>\n${read('style.css')}</style>\n` : '') +
    `<script>window.__DEMO_STATE__ = ${embed(st)};</script>\n` +
    `<script>\n${read('shim.js')}${ribbon ? '' : '\ndocument.documentElement.dataset.noRibbon = "1";'}</script>\n`;

  return page.replace(marker, `${inject}${marker}`);
}

const out = render(state);

const asScript = process.argv[1] && process.argv[1].endsWith('build.mjs');
if (asScript && process.argv.includes('--check')) {
  let have = '';
  try { have = read('index.html'); } catch { /* not generated yet */ }
  if (have === out) { process.stdout.write('demo/index.html is current\n'); process.exit(0); }
  process.stderr.write(
    'demo/index.html is STALE — board.html, the shim or the state changed under it.\n' +
    '  node demo/build.mjs   regenerates it\n'
  );
  process.exit(1);
}

if (asScript) {
  writeFileSync(join(HERE, 'index.html'), out);
  const q = (state.questions || []).length;
  const c = (state.changes || []).length;
  process.stdout.write(`demo/index.html written — ${q} cards, ${c} changes, ${Math.round(out.length / 1024)} KB\n`);
}

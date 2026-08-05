---
name: grill-board
description: Grill the user on a plan, design or spec through a live web board instead of one blocking question at a time. Posts a batch of roomy, self-contained questions they answer in any order at their own pace; each answer wakes the session to branch follow-ups into that thread while they keep answering the rest. Use when the user says "grill-board", "grill me in parallel", "batch grill me", or wants a plan stress-tested without being blocked on one question at a time.
---

# grill-board

The asynchronous sibling of `/grill-me`. Same goal — interrogate a plan until
there is shared understanding, resolving every branch of the decision tree, with
a recommended answer on every question. Two things differ, and both exist
because the synchronous version stalls:

- **You never block.** Questions go on a board. The user answers whichever one
  they like, in whatever order, whenever. You are woken by their answers.
- **Questions are roomy.** The board renders full markdown per question — code
  blocks, tables, tradeoffs. Put *everything needed to answer* inside the
  question. There is no "as we discussed above"; each card must stand alone.

## The loop

```
seed a batch ──► user answers any card ──► you wake ──► branch that thread
     ▲                    (never blocked)                      │
     └──────────────── new cards appear live ◄─────────────────┘
```

You are woken by a `Monitor` event per answer. **Between wakes you end your
turn.** Do not sit in a polling loop — that burns tokens and adds nothing.

## Run it

Everything is one zero-dependency script next to this file. `$S` below is a
fresh state path — `~/.claude/grill-board/<yyyy-mm-dd>-<topic-slug>/state.json`.
Export it once at the start so every later command is a one-liner.

**Time to the first question is the number that matters.** The board is
append-only and the page polls, so cards appear as you write them. Serving costs
~80ms and posting ~90ms — all the rest of the wait is you. So never author a
batch before showing anything.

**1. Put the board up before you read anything.** `serve`, `add` and `watch` do
not depend on each other — the last two touch the state file, not the server —
so issue all three in **one message**:

`serve`, with `run_in_background: true`:

```bash
node ~/.claude/skills/grill-board/board.mjs serve --state "$S" --title "Sync conflict model"
```

the first questions, heredoc straight to stdin — no temp file, no second round trip:

```bash
node ~/.claude/skills/grill-board/board.mjs add --state "$S" --file - <<'JSON'
[{ "thread": "Scope", "title": "…", "context": "…", "options": [] }]
JSON
```

and the watcher:

```
Monitor({ command: 'node ~/.claude/skills/grill-board/board.mjs watch --state "$S"',
          description: 'grill-board answers', persistent: true })
```

**2. Make those first cards the ones that need no reading.** Scope, priorities,
what "done" means here, what you would cut, which half of this they actually
care about. They are real judgement calls, they never need the codebase, and
they are the fastest to answer — so the board is *useful* within a second of the
URL existing. Two or three is plenty.

Then hand over the URL — `cat "$(dirname "$S")/url"` gives the local one and the
LAN one, and the board answers fine from a phone. Say once that the board is
fully keyboard-driven: arrows or `WASD` move, `→` steps into a card's choices
and `←` back out, `⌘↵` sends, `?` lists the rest.

**3. Now explore, appending as you write.** Read the plan, diff, spec or code.
Anything the codebase can answer, answer by reading it — never spend a card on
it. Post each small batch of two or three **the moment it is written**; the page
picks it up in under a second. Accumulating eight cards and posting them at the
end recreates exactly the wait this board exists to remove.

Roots must be *independent of one another*, because they get answered out of
order. If B only makes sense once A is settled, B is not a root — it is a
follow-up you write later. Aim for 5–8 roots across 3–5 named threads.

**4. End your turn.** Say what is on the board and stop.

**5. On every wake**, drain and act:

```bash
node ~/.claude/skills/grill-board/board.mjs new --state "$S"     # JSON, advances the cursor
```

For each event:

| event | what you owe them |
|---|---|
| `answer` | Branch: 0–3 follow-ups **in that thread** if real ambiguity remains. Then re-read every *other* open card — retire any the answer just made moot, and revise any it contradicts. |
| `skip` | They deferred to your recommendation. Record it as decided-by-you and move that thread on. |
| `pushback` | The question was wrong. Retire it and re-ask it properly — do not defend it. |
| `simpler` | The question was unanswerable as written — too dense, too much jargon, too many things at once. Retire it and ask the **same decision** again in plain words, splitting it if it was really two questions. Do not just shorten it, and do not drop the detail that made it decidable. |
| `message` | Steering. Obeys immediately, even if it means retiring a whole thread. |

Then set the liveness note, post new cards, and **end your turn again**:

```bash
node ~/.claude/skills/grill-board/board.mjs note --state "$S" --text "branching on conflicts"
node ~/.claude/skills/grill-board/board.mjs add --state "$S" --file next.json
node ~/.claude/skills/grill-board/board.mjs retire --state "$S" --id q7,q9 --reason "settled by q4"
```

**6. Finish** when `[drained]` arrives and no thread has anything left worth
asking. Then produce the payoff — not a transcript dump:

```bash
node ~/.claude/skills/grill-board/board.mjs export --state "$S" --out decisions.md
```

Write, in the conversation: the decisions reached (with who decided — them or
you-by-default), the ones still genuinely open, and what you now recommend
building. Offer to stop the server.

## Writing a good card

```json
{
  "thread": "Conflict resolution",
  "parentId": "q4",
  "title": "What wins when two devices edit the same piece offline?",
  "context": "Both clients stamp `updatedAt` locally...\n\n```ts\n// pieceProgressStore.ts:88\n```\n\n| | last-write-wins | per-field merge |\n|---|---|---|\n| cost | ~20 lines | ~200 |",
  "recommendation": "Last-write-wins. Two-device conflicts need the same piece within one sync window — rare enough that the merge cost isn't repaid.",
  "options": [
    { "label": "Last-write-wins on updatedAt", "detail": "Simplest. A loses silently.", "recommended": true },
    { "label": "Merge per field", "detail": "No data loss; needs per-field clocks." },
    { "label": "Ask the user on conflict", "detail": "Never wrong, always annoying." }
  ],
  "multi": false,
  "queued": false
}
```

Rules that make or break this:

- **`title` is one line.** The decision, phrased as a question. Not a paragraph.
- **`context` carries the weight.** Real file paths and line numbers, the actual
  code, the actual numbers, the tradeoff table. This is the whole reason the
  board exists — use the space. Long is fine; vague is not.
- **Options are concrete and mutually exclusive**, 2–4 of them, each with a
  `detail` naming its real cost. Exactly one gets `recommended: true` — you
  always have a view, as in `/grill-me`.
- **Never ask what the code answers.** Go read it.
- **Never ask two things in one card.** Split it.
- `multi: true` only when picking several genuinely composes.
- `queued: true` parks a card until the board drains — use it for depth you
  know you will want but that would crowd the board now.

## The queue

The board shows at most 8 open cards (`--max-open`). Anything beyond that waits
in `queued` and is promoted automatically as answers land. So: write follow-ups
freely — you cannot flood them. What you must not do is let a *thread* run
deeper than ~4, or ask a follow-up that merely restates a settled decision. A
thread ends when the next question would not change what gets built.

## Rules

- **Never call `AskUserQuestion` during a run.** Every question goes on the
  board. Blocking them is the bug this skill exists to fix.
- **One wake, one turn.** Drain events, branch, post, stop. Do not poll.
- Do not wait for the board to drain before branching — the user is answering
  other cards while you write, which is the entire point.
- If they answer nothing for a long stretch, that is fine. Stay quiet; the
  monitor is still armed.
- Keep the `note` current on every wake — it drives the liveness dot in the
  header and is that dot's tooltip. **A few words, not a sentence**; the board
  deliberately gives it no room on screen. It greys out after two minutes.
- The server binds `0.0.0.0` so a phone on the LAN can answer. Pass
  `--host 127.0.0.1` to keep it on the machine.
- Ports auto-select from 7800 upward, so concurrent sessions do not collide.

## Command reference

| | |
|---|---|
| `serve --state P [--port N] [--host H] [--title T] [--subtitle S] [--max-open N]` | start the board, print URLs (the subtitle is the title's tooltip — keep the title itself short and load-bearing) |
| `add --state P --file F` | append questions (JSON array; `-` for stdin) |
| `new --state P` | unprocessed events as JSON, advances the cursor |
| `watch --state P` | one stdout line per event — for `Monitor` |
| `retire --state P --id q3,q4 --reason R` | kill cards a later answer made moot |
| `note --state P --text T` | set the liveness line shown in the header |
| `status --state P` | counts and unread total |
| `export --state P [--out F]` | markdown transcript |

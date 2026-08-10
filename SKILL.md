---
name: grill-board
description: Reach agreement on a plan, design, spec — or on how a change is actually going to be written — through a live web board instead of one blocking question at a time, then build what was agreed and hand every diff back for review against the answer that caused it. Posts roomy, self-contained questions answered in any order; each answer wakes the session to branch follow-ups while the rest stay answerable. For a bug or a change it diagnoses first and grills on the implementation forks, so the user is in the code decision rather than describing the problem; when the questions run out it shows the build happening on the same board and reviews each change against its decisions. Use when the user says "grill-board", "grill me in parallel", "batch grill me", or prefixes a task with it ("grill-board fix the retry loop"), or wants a plan stress-tested without being blocked one question at a time.
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
                                │
                          board drains
                                ▼
              build it, live on the same board
                                │
                                ▼
     every change back as a card, next to the answer that caused it
                       accept · change the code · reopen the decision
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
| `ask` | They could not answer it **as written**. Retire the card and re-ask the *same decision*, fixed per `kind` below. Never answer it for them, and never drop the detail that made it decidable. |
| `message` | Steering. Obeys immediately, even if it means retiring a whole thread. |

An `ask` carries a `kind`, and the three want genuinely different things:

| `kind` | What the replacement card must do |
|---|---|
| `simpler` | Too dense to answer. Say it in plain words — no jargon, no nested clauses — and **split it** if it was really two decisions wearing one title. Shortening it is not the fix; being answerable is. |
| `implications` | They can read the options but not their consequences. Spell out, per option, what it commits them to: what it costs, what it forecloses, what breaks later, what has to be built. Then ask the same question again with that in the context. |
| `perspective` | They lack the vantage point to judge. Supply what a decision like this actually turns on — who it hurts when it's wrong, how it has gone elsewhere, which of their own constraints bears on it — and re-ask. Give the frame, not the answer. |

Then set the liveness note, post new cards, and **end your turn again**:

```bash
node ~/.claude/skills/grill-board/board.mjs note --state "$S" --text "branching on conflicts"
node ~/.claude/skills/grill-board/board.mjs add --state "$S" --file next.json
node ~/.claude/skills/grill-board/board.mjs retire --state "$S" --id q7,q9 --reason "settled by q4"
```

**6. When `[drained]` arrives** and no thread has anything left worth asking,
the questions are over. What happens next depends on what the answers describe:

- **Something you can write now** — a fix, a refactor, a feature whose shape is
  now settled. **Build it.** Do not stop to ask permission: twenty answered
  questions *were* the permission, and asking again is the blocking move this
  skill exists to delete. Go to "Past the last question" below.
- **Something you cannot** — a strategy, a spec, a roadmap, work that needs
  people or time you do not have. Then the payoff is the document. Export,
  write up the decisions reached (with who decided — them or you-by-default),
  what is still genuinely open, and what you recommend. Offer to stop the server.

```bash
node ~/.claude/skills/grill-board/board.mjs export --state "$S" --out decisions.md
```

## Past the last question: build, then review

A decision that never becomes code was a conversation, not an agreement. So the
board keeps going: it shows the build happening, then hands every change back
with the decisions that produced it attached.

**1. Post the plan before you write a line of it.** Not before the first edit —
before the first *read*. The moment you judge the questions to be over, the plan
goes up; only then do you start opening files. This is the same rule as seeding
cheap questions first, and it is the one most easily lost, because between the
last answer and the first step there is real thinking to do and the board is
watching you do it.

They have just answered twenty questions and are sitting on a page that went
quiet. The board fills that silence on its own — the moment the last card is
answered it says *"nothing left to answer — Claude is reading your answers"* and
starts counting the minutes. Treat that as the floor, not the job: it can say
that work is happening, but only your plan says **what**, and only the plan tells
them a review is coming.

```bash
node ~/.claude/skills/grill-board/board.mjs build --state "$S" --file - <<'JSON'
[{ "title": "Split retryable vs terminal in classifyError", "because": ["q1","q3"] },
 { "title": "Backfill the 41 stuck rows", "because": ["q2"] }]
JSON
```

Every step names the questions that produced it. A step that traces back to no
answer is a step nobody asked for — either it is groundwork (fine, say so) or
you are building something they did not agree to.

Two optional fields on a step decide whether the build can be shared:
`needs: ["s1"]` for what must finish first, and `files: [...]` for what it
expects to touch. Alone you can skip both. With several agents they are the
difference between parallel and merely simultaneous.

**2. Mark each step as you reach it**, never in a batch at the end. The panel is
the only sign anything is happening.

```bash
node ~/.claude/skills/grill-board/board.mjs build --state "$S" --step s1 --status running
node ~/.claude/skills/grill-board/board.mjs build --state "$S" --step s1 --status done --note "3 callers re-tested"
```

**3. Log each change the moment it lands** — in the same breath as marking its
step done, not batched at the end. A step marked done with no change logged is
the board's worst state: it reports progress and shows none of it, and the
person watching has no way to tell a build that is going well from one that is
going wrong. The board says so out loud once it happens (*"nothing sent for
review yet"*), which is a symptom, not a fix.

Write the JSON with the `Write` tool rather than a heredoc — a diff is full of
quotes, backslashes and newlines, and hand-escaping it into a shell string is a
turn wasted every time.

```bash
node ~/.claude/skills/grill-board/board.mjs change --state "$S" --file /tmp/c1.json
```

**4. Hand it back.** Marking the **last** step settled does this for you: the
changes go up for review and the board flips to `review` in the same write, so a
finished build cannot end in silence. Run it by hand only to send changes up
before the build is over.

```bash
node ~/.claude/skills/grill-board/board.mjs review --state "$S"
```

The one case it cannot rescue is a build that logged nothing — there is then
nothing to review, and rather than claim otherwise the board stays in `building`
and tells you the changes you owe.

Every logged change becomes a card carrying its summary, its files, **the
decisions that caused it with the answers they gave**, and the diff. The queue
cap lifts for the batch: a review is finite and revealing it a few at a time
leaves them unable to tell whether they have seen the one that matters.

**5. On a review wake** the event says `[review] c3 from q1 — <verdict>`:

| verdict | what you owe them |
|---|---|
| `looks right` | Nothing. Do not thank them, do not re-explain it. |
| `change the code` | Rewrite it, then **re-log under the same `id`**. The card reopens at revision 2 with the new diff. Never open a second change for a rewrite of the first. |
| `reopen the decision` | The code was faithful; the decision was wrong. `add` that question again as a fresh card — sharper for what building it taught you — and rebuild when it is answered. |

A verdict with free text is the normal case, and the text outranks the button.
"Looks right, but rename that flag" is a rewrite, not an acceptance.

**6. `[reviewed]` means every change has a verdict.** Export the record and say
what stands. Offer to commit; do not commit unasked.

## Splitting the build across several agents

A build of more than three or four independent steps is worth fanning out. The
board is the work queue: agents claim steps from it, and **the claim is what
keeps them off each other.**

Every agent needs a name — `--as <name>` — and it must be one word that says
what it is doing (`outbox`, `backfill`, `docs`), never `agent2`. It appears on
the board next to the step it is holding and on every change it writes, and the
first question you will be asked is "which one is stuck".

**The lead** drains the grill, posts the plan with `needs` and `files` on every
step, then spawns one subagent per parallel track and stops. It does not claim
anything itself. Its watch stays unfiltered, so it still sees the whole board.

**Each worker** runs this loop, and nothing else:

```bash
B=~/.claude/skills/grill-board/board.mjs
node $B claim --state "$S" --as outbox        # exit 3 = wait, 0 with no step = done
# ... do exactly that step, nothing outside it ...
node $B build  --state "$S" --as outbox --step s1 \
  --decided "Kept the 12-attempt cap — q3 said fix the class, and lowering it here would change the other two queues too"
node $B change --state "$S" --as outbox --file /tmp/c.json
node $B build  --state "$S" --as outbox --step s1 --status done --note "3 callers re-tested"
```

### Say what you decided, or it is lost

**Every call you make that the plan did not make for you goes back on the board
with `--decided`.** This is not bookkeeping. The lead handed you a one-line step
and got back a diff; without this, the only way for it to learn *why* the lemma
match beat the surface match is to read your code and guess — which costs more
than the step did, and is exactly what fanning out was supposed to save.

```bash
node $B build --state "$S" --as outbox --step s8 \
  --decided "Matched on (lemma, pos), not surface form — two of the three callers already normalise and the third was the bug" \
  --decided "Used a partial index; the table is 40M rows and this write path is hot" \
  --flag "sentence_forms.position is written from here — if the slot rules ever diverge the indices are wrong"
```

- **Repeatable.** One `--decided` per call you made, not a paragraph.
- **Say what you chose *over what*, and why.** "Used a partial index" is a
  changelog entry. "Used a partial index rather than a full one, because the
  table is 40M rows and this write path is hot" is a decision someone can
  overturn.
- **`--flag` is for what the next person needs to know** — a landmine you found,
  something that turned out unlike the plan, something you deliberately left.
- **Recording is not finishing.** With no `--status`, the step does not move —
  so record a call the moment you make it, while the reason is still in front of
  you, rather than reconstructing it an hour later.
- Only the holder may record on a step, same as moving it.

Settling a step with nothing recorded is allowed — "run the typecheck" decides
nothing — but on a shared board it warns, and `decisions` marks it as a step
somebody will have to read back.

`claim` takes **one** step, atomically. Two agents cannot hold the same one —
the pick and the mark happen inside the same lock as every other write. What
comes back tells you what to do next:

| | |
|---|---|
| a step | It is yours. Do that step and nothing else. |
| exit 3 | Nothing takeable *yet* — it prints who holds what and what waits on what. Something is still running, so wait and claim again. |
| exit 0, no step | Every step is done. Stop; the loop is over. |
| `OVERLAP` on stderr | Another live step declares a file you also declared. It is a warning, not a refusal, because plans guess at their file lists — go and look before you write. |

**Never work a step you did not claim.** Not "while I'm in that file anyway",
not "it was obviously next". The queue is the only thing preventing two agents
from writing the same file, and it only works if nobody reaches around it.

A step held by an agent that died blocks the queue. `claim` will not take it
automatically — silently stealing work from an agent that is merely slow is how
you get two writers in one file. It tells you who holds it and for how long;
`--steal s3` takes it deliberately, and says so on the board.

Release what you cannot finish, rather than holding it:

```bash
node $B release --state "$S" --as outbox --step s3 --failed --reason "needs a decision we never made"
```

**Draining events is per agent.** Pass `--as` to `new` and `watch` and each
agent gets its own cursor — without it they share one, and whoever calls first
swallows everyone else's wake:

```
Monitor({ command: 'node ~/.claude/skills/grill-board/board.mjs watch --state "$S" --as outbox --mine',
          description: 'verdicts on outbox changes', persistent: true })
```

`--mine` narrows a worker to what it must act on: verdicts on changes **it**
wrote, plus messages. Everything else — grill answers, the drain lines — is the
lead's. Workers use `--mine`; the lead never does.

So a `change the code` verdict wakes exactly the agent that wrote that change,
which is the one that still knows why.

### What the lead reads

A step landing wakes the lead, and **the wake carries the handback** — it does
not point at it. There is no second command to run and no diff to open:

```
[step] s8 done by backfill — Lexeme identity (3 callers re-tested) · c7 c8
    decided: Matched on (lemma, pos), not surface form — two of the three callers
             already normalise and the third was the bug
    FLAG: sentence_forms.position is written from here — if the slot rules ever
          diverge the indices are wrong
```

For the standing picture — a lead that has just picked the board up, or is about
to write the summary — one command gives every step, who did it, what it wrote,
and what it settled:

```bash
node $B decisions --state "$S"            # everything
node $B decisions --state "$S" --as backfill   # one agent
node $B decisions --state "$S" --step s8       # one step
```

A settled step that recorded nothing says so, in those words. That is the point:
the lead needs to know *which* steps it still has to read back, not to discover
later that it never knew.

The lead's own job on a handback is to read it, not to re-derive it. Act when a
decision contradicts an answer on the board, when two workers decided
incompatible things, or when a `FLAG` changes what a later step should do — and
otherwise leave it alone. The decisions also ride onto the review cards, so the
user judges them too; a call nobody asked about is exactly what review is for.

### Writing a change entry

```json
{
  "title": "classifyError now splits retryable from terminal",
  "because": ["q1", "q3"],
  "files": ["backend/src/sync/classify.ts:40-72", "backend/src/sync/outbox.ts:112"],
  "summary": "A 4xx and a CHECK violation are now **terminal**: the outbox moves them to dead-letter instead of sleeping and retrying forever. The other two `classifyError` callers pick this up for free, which is what you asked for in q3.",
  "risk": "I kept your max-attempts cap as a backstop at **5**. That number is a guess — everything else follows from your answer.",
  "spoken": "The error classifier now tells a temporary failure from a permanent one, so a 401 stops instead of retrying for ever.",
  "diff": "--- a/backend/src/sync/classify.ts\n+++ b/backend/src/sync/classify.ts\n@@ -40,9 +40,15 @@\n-  return { kind: 'error' as const };\n+  const status = statusOf(e);\n+  if (status && status >= 400 && status < 500) return { kind: 'terminal' as const, status };\n+  return { kind: 'retryable' as const, status };"
}
```

- **`because` is the point of the whole thing.** Without it you are asking
  someone to approve a diff and remember unaided what they asked for. It is a
  list because one change often settles two answers; the same question showing
  up under three changes is normal and correct.
- **One change per thing they could sensibly say no to.** Not one per file, not
  one per commit. If half of it could be accepted and half rejected, it is two.
- **`title` says what changed, not what you did.** "classifyError now splits
  retryable from terminal", never "Updated classifyError".
- **`summary` is prose, and it is what a voice client reads out** in place of
  the diff. Say what is now true, not what you edited.
- **`risk` is the guess you made**, and it becomes the card's "What I'm least
  sure about". Not "I think this is right" — name the number you invented, the
  case you did not handle, the test you did not write. If there is genuinely
  nothing, leave it out rather than padding it.
- **`diff` is the real diff.** `git diff -- <file>` output, not a paraphrase and
  not the whole file. Trim it to the hunks that matter; a 400-line diff in a
  card is not a review, it is a dare.
- Changes that fell out of the work and answer no question — a lockfile, a
  formatting pass — still get logged, with no `because`. They are listed as
  groundwork. The CLI warns about them on stderr; that warning is for you, not
  a failure.

## When the subject is a change, not a plan

`/grill-board fix the outbox retry` is **not** a request to describe the bug back
to them. They already know the symptom — they want to be in the *code decision*.

**Diagnose first, and silently.** Reproduce it, read the code, find the actual
cause. Never spend a card asking where the bug is, what the error said, or how to
reproduce it: if the repo can answer that, answering it is your job, not theirs.
Arriving with *"found it — the retry loop treats every failure as transient,
`outbox.ts:112`"* and only **then** asking how to fix it is the entire point.

**The cards are about the fix, not the fault.** Every one is a real fork in the
implementation with the actual code in it. What genuinely needs them:

| | |
|---|---|
| **Cause or symptom** | The real cause is two layers down. Fix it there, or contain it here? Different blast radius, different risk of a second bug. |
| **Blast radius** | The honest fix changes a function with other callers. Change it, fork it, or wrap it — and who gets re-tested. |
| **The behaviour nobody chose** | Many bugs exist because no one ever decided what *should* happen. That decision is theirs, not yours. |
| **Scope** | This instance, or the class of it? Say plainly what else is broken the same way, and let them decide. |
| **Proof and repair** | What test pins it so it cannot come back — and whether data already written wrong needs fixing too. |

Never ask "shall I fix it?" — that is what they asked for. Ask **how**.

Cards that need no reading, so the board is useful in seconds: how much this is
worth spending (a patch today or the right fix), whether they already suspect a
cause, and whether changing the current behaviour is even allowed.

Finish differently too. A change is by definition buildable, so when the board
drains you go straight into "Past the last question" — plan on the board, build
it, hand every diff back for review against the answer that caused it. You do
not stop to offer.

A fix-shaped card looks like this. Note that it arrives already knowing the
cause, and that the choices are three implementations, not three theories:

```json
{
  "thread": "Outbox",
  "title": "A 4xx retries forever. Fix it at the classifier or at the queue?",
  "spoken": "I found it — the retry loop treats every failure as temporary, so a permanent 4xx never stops. There are two places to fix that. Do you want the queue to decide when to give up, or the thing that reads the response to say up front whether it is worth retrying?",
  "context": "```ts\n// backend/src/sync/outbox.ts:112\ncatch (e) { await sleep(backoff); return retry(job); }   // no terminal case\n```\n\nA 401 and a CHECK violation both land here, and neither can ever succeed.\n\n| | at the classifier | at the queue |\n|---|---|---|\n| touches | `classifyError` — 3 callers | `outbox.ts` only |\n| fixes the class | yes, everywhere | this queue only |\n| re-test | all 3 callers | the outbox |",
  "recommendation": "Classifier. The other two callers have the same latent bug, and a retryable/terminal split is the thing that was actually missing.",
  "options": [
    { "label": "Split retryable vs terminal in classifyError", "detail": "Fixes the class. Re-tests 3 callers.", "recommended": true },
    { "label": "Give the outbox a max-attempts cap", "detail": "Smallest diff, contained. The other callers stay broken and 401 still burns the cap." },
    { "label": "Cap now, classifier next week", "detail": "Unblocks today. The follow-up is the one that never happens." }
  ]
}
```

## Writing a good card

```json
{
  "thread": "Conflict resolution",
  "parentId": "q4",
  "title": "What wins when two devices edit the same piece offline?",
  "spoken": "Two devices edit the same piece offline, then both sync. One of those edits has to lose. Should the later timestamp just win, or should the two be merged field by field?",
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
- **`spoken` is that question for the ear.** A voice client reads it aloud, and
  the listener has no screen — so no file paths, no code, no "the table above".
  Name the tension in a sentence or two and make the choice audible. Test: could
  someone answer it having heard only this? If not, the card is doing too much
  and wants splitting. Write one for every card; without it a narrator has to
  improvise from `context`, which is where the detail quietly goes missing.
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
- **The building phase is the one place you hold the turn for a long time**, and
  it is the one place they cannot see what you are doing. The step marks are the
  whole signal. Move one before you start it and again when it lands — a panel
  frozen on step 1 for ten minutes is indistinguishable from a dead session.
- The server binds `0.0.0.0` so a phone on the LAN can answer. Pass
  `--host 127.0.0.1` to keep it on the machine.
- Ports auto-select from 7800 upward, so concurrent sessions do not collide.
- **Give `$S` a state path nothing else will pick.** The date and topic slug
  collide when two sessions grill the same subject on one day, and two grills
  sharing a state file used to merge silently into one board. `serve` now
  refuses that — if it tells you a different grill is already there, choose a
  new path. `--adopt` joins an existing board on purpose, which is only ever
  what you want when you *are* the second agent on one build.
- **If a command warns that the server is older than board.mjs, restart it
  before doing anything else.** A `serve` process keeps whatever code it booted
  with, so a board running across an update to this skill can accept every write
  and serve none of it — the state file fills with a build the page is never
  told about, and the board looks idle while you work. The warning prints the
  exact `kill … && … serve … --adopt &` to run. Nothing is lost; the state file
  is the truth and the new server reads it.

## Command reference

| | |
|---|---|
| `serve --state P [--port N] [--host H] [--title T] [--subtitle S] [--max-open N] [--token]` | start the board, print URLs (the subtitle is the title's tooltip — keep the title itself short and load-bearing) |
| `mcp --state P` | MCP over stdio, so another session can read and answer this board. Also served at `POST /mcp` for a client that must reach it over a network |
| `gateway [--port N] [--token]` | long-lived front door serving whichever board is current, for a tunnel + connector registered once. `serve` claims it and registers itself automatically — nothing to do per board. With several grills running, the voice client can `list_boards` and `use_board` to switch |
| `add --state P --file F` | append questions (JSON array; `-` for stdin) |
| `new --state P` | unprocessed events as JSON, advances the cursor |
| `watch --state P` | one stdout line per event — for `Monitor` |
| `retire --state P --id q3,q4 --reason R` | kill cards a later answer made moot |
| `note --state P --text T` | set the liveness line shown in the header |
| `status --state P` | counts, phase, build progress, every change and its verdict |
| `export --state P [--out F]` | the record: decisions, what each one produced, the build, every change with its diff and verdict |
| `build --state P --file F` | declare the build; the board flips to `building` and shows the steps. Steps take `needs` and `files` |
| `build --state P --step s2 --status running\|done\|failed [--note N] [--as W]` | move one step. Only its holder may, unless `--force` |
| `change --state P --file F [--as W]` | log built changes (JSON array). Re-logging with an existing `id` rewrites it and reopens its review |
| `review --state P` | turn every unreviewed change into a card, with its decisions attached |
| `claim --state P --as W [--step s3] [--steal s3]` | take one step, exclusively. Exit 3 = wait, exit 0 with no step = the build is done |
| `release --state P --as W [--step s3] [--failed] [--reason R]` | hand a step back |
| `build --state P --step s8 --decided "..." [--decided "..."] [--flag "..."]` | record a call you made. Repeatable; with no `--status` the step does not move |
| `decisions --state P [--step s8] [--as W]` | what every worker settled, and which settled steps recorded nothing |
| `new`/`watch --as W [--mine]` | that agent's own event cursor; `--mine` narrows a worker to verdicts on what it wrote |

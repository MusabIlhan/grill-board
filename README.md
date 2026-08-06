# grill-board

A Claude Code skill that interrogates a plan through a **live web board** instead
of one blocking question at a time.

`/grill-me` asks one question, then waits. You answer, it thinks, you wait again.
`grill-board` posts questions to a page you keep open: answer whichever you like,
in whatever order, whenever. Each answer wakes the session, which branches
follow-ups into that thread **while you carry on answering the others**.

```
seed a batch ──► you answer any card ──► the session wakes ──► it branches that thread
     ▲                   (never blocked)                                │
     └──────────────── new cards appear live ◄────────────────────────--┘
```

It works on a change as well as a plan. `/grill-board fix the retry loop`
diagnoses first, then asks about the **implementation forks** — fix the cause or
contain the symptom, change a shared function or fork it, this instance or the
class — with the actual code in each card. You end up in the code decision
instead of describing the bug.

Then it builds what you decided, on the same board.

Three things make it different from a chat prompt:

- **You are never blocked.** Questions queue on a board, not in the conversation.
- **Questions are roomy.** Each card renders full markdown — code, tables,
  tradeoffs — so everything needed to answer is *in* the question.
- **It doesn't end at agreement.** The board drains, the build appears on it
  step by step, and every change comes back as a card carrying the answers that
  produced it.

## Install

```bash
git clone https://github.com/MusabIlhan/grill-board.git ~/.claude/skills/grill-board
```

Node 18+. No dependencies, nothing to build.

Then, in Claude Code:

```
/grill-board the sync model in this plan
```

It prints a `localhost` URL and a LAN one — the board answers fine from a phone.

## Answering

Everything works from the keyboard. Press <kbd>?</kbd> on the board for the list.

Navigation has two levels — the cards, and the choices inside one card.
**Up/down always moves. Right steps in, left steps back out.**

```
cards  ──→──  that card's choices  ──→──  typing your own
       ←──                         ←── esc
```

| | |
|---|---|
| <kbd>W</kbd> <kbd>S</kbd> / <kbd>↑</kbd> <kbd>↓</kbd> | Up and down, on whichever level you're on |
| <kbd>D</kbd> / <kbd>→</kbd> | Step in · <kbd>A</kbd> / <kbd>←</kbd> step out |
| <kbd>N</kbd> | Next unanswered |
| <kbd>1</kbd>–<kbd>9</kbd> | Pick a choice directly |
| <kbd>space</kbd> | Take the highlighted choice — from the card level, Claude's pick |
| <kbd>⌘↵</kbd> | Send — the same key on a choice as in the text |
| <kbd>↵</kbd> | Reopen an answered card |
| <kbd>C</kbd> <kbd>E</kbd> | Write your own · show Claude's take |
| <kbd>T</kbd> <kbd>I</kbd> <kbd>V</kbd> | Ask simpler · implications · perspective |
| <kbd>M</kbd> <kbd>L</kbd> <kbd>P</kbd> | Tell Claude something · light/dark · palette |

Three ways to say **"I can't answer this yet"**, and they ask for different
things back. **Ask simpler** — too dense as written, so it gets re-said plainly
or split in two. **Implications** — you can read the options but not their
consequences, so each one comes back with what it commits you to. **Perspective**
— you lack the vantage point, so the question returns with what a decision like
this actually turns on.

None of them answers for you, and none drops the detail that made the question
decidable. The card is retired and re-asked.

A card you're merely passing over never shows a highlighted choice — a highlight
you didn't put there reads as a decision already made for you. Choices you move
through are provisional and vanish when you leave or start writing your own; one
you actually pick (space, a number, a click) stays, so "option 2, but…" works.

**Push back** is the one worth knowing about: it tells the session the *question*
is wrong, and it retires and re-asks rather than defending it.

Eight palettes ship (Gruvbox, Catppuccin, Nord, Solarized, Rosé Pine, Everforest,
Tokyo Night, GitHub), light and dark. All 16 combinations were contrast-audited:
every text pair clears WCAG AA, every glyph clears 3:1. Default is Nord dark; the
choice persists across boards.

## Building, and reviewing what got built

A decision that never becomes code was a conversation, not an agreement. So the
board doesn't stop when the questions do.

When it drains, the plan goes up first and the header flips to **building** — a
panel of steps that tick over as they land, each showing which answers it came
from. The board is never blank while the session works.

```
Building what you decided                          2/4
  ✓  Split retryable vs terminal in classifyError   q1 q3
  ✓  Backfill the 41 stuck rows                        q2
  ◐  Regression test for a 401 in the outbox           q1
  ·  Re-test the other two classifyError callers       q3
```

Then every change comes back as a card. Not a diff on its own — a diff with
**the questions that caused it and the answers you gave**, printed above it:

> **Because you decided**
> - **q1** A 4xx retries forever. Fix at the classifier or the queue?
>   → Split classifyError — *"yes but keep the cap too"*

Three answers: **looks right**, **change the code** (the decision stands, say
what to fix — it's rewritten and the card reopens at revision 2), or **wrong
call, reopen q1** (the code was faithful, the decision wasn't). Free text beats
the button: *"looks right, but rename that flag"* is a rewrite, not an approval.

Each answered question grows a `Built: c1` link, so a decision and its code are
one click apart in both directions. The same three keys, the same voice client,
the same board.

`export` then writes the record — every decision, what it produced, every change
with its diff and its verdict — which is the thing you actually keep.

## Several agents on one build

Past three or four independent steps, building them in a line is just slow. So
the board doubles as the work queue: agents **claim** steps off it.

```
Building what you decided — 3 agents               1/4
  ◐  Split retryable vs terminal in classifyError    outbox    q1 q3
  ·  Backfill the 41 stuck rows        waits on s1                q2
  ◐  Regression test for a 401 in the outbox         tests        q1

     outbox s1    tests s3    docs idle
```

A claim is exclusive — the pick and the mark happen inside the same lock as
every other write, so two agents racing for the last step cannot both win it. A
step declares what must finish before it (`needs`) and what it expects to touch
(`files`); the first gates the claim, the second warns when two live steps are
heading for the same file. Nothing is taken from a slow agent silently: you're
told who holds it and for how long, and `--steal` says so on the board.

Every change is signed, so *"why is it done that way"* has someone to ask. And
each agent keeps its own event cursor — so a **change the code** verdict wakes
exactly the agent that wrote that change, which is the one that still knows why.

## Answering out loud

The board is also an MCP server, so another session — one with a voice mode, on
your phone — can read the questions and record your answers. It talks; you talk
back; the grilling session keeps branching on your Mac.

**Set it up once.** The gateway is a long-lived front door that serves whichever
board is *currently* running, so the URL you register never goes stale:

```bash
node board.mjs gateway --token          # prints an MCP URL and a token
cloudflared tunnel --url http://localhost:7799   # or: ngrok http 7799
```

Register `https://…/mcp?t=<token>` once as a custom connector. Every `serve`
claims itself as the current board on startup, so from then on you just run
`/grill-board` as normal and the voice session picks it up — no re-registering,
no per-board configuration.

For a second session **on the same machine** there's no need for any of that:

```bash
node board.mjs mcp --state <path>       # MCP over stdio
```

Seven tools: `list_questions`, `read_question`, `answer`, `ask_better`,
`board_status`, plus `list_boards` / `use_board` for when several grills are
running at once. What makes it work is that **`answer` takes free text** — you
say *"the first one, but only if we log the discards"* and that sentence is
recorded verbatim. Nothing tries to match it to an option key; the grilling
session reads it exactly as it reads a typed note.

Each card carries a `spoken` line written for the ear — no file paths, no
tables. `read_question` returns the full detail for when you ask for it, so the
narrator never has to improvise from a code block.

This covers the review too: `board_status` reports the build as it happens, and
a review card's spoken detail is the change described in prose, never the diff.
You can approve, redirect or reopen a decision without looking at anything.

**`--token` is not optional once the board leaves your machine.** Without it the
board is readable and *writable* by anyone who can reach the URL, which is a
problem the moment you tunnel it. It's accepted as `?t=` or a bearer header.

The seam is the state file, not HTTP — so an answer given by voice wakes the
grilling session exactly as a keystroke does, and you can switch between phone
and keyboard mid-board without telling either one.

## How it works

A zero-dependency Node server and a single HTML page.

```
board.mjs      server + CLI (serve, add, new, watch, retire, note, status, export,
                             build, change, review, claim, release, mcp, gateway)
board.html     the page
SKILL.md       the instructions Claude follows
test-claim.sh  the claim protocol, raced for real
```

State is one JSON file per board. The CLI writes questions into it, the page
polls for them, and `board.mjs watch` emits one line per answer — which Claude
Code's `Monitor` turns into a wake-up. Between wakes the session ends its turn,
so it costs nothing while you think.

**Why not a published Artifact?** An Artifact's CSP blocks every outbound
request, so the page could display questions but never send answers back. A
local server is what closes the loop.

Notes on the parts that are less obvious than they look:

- **Writes take an exclusive lock.** `serve` and `add` are issued together and
  the page answers while the session posts, so overlapping writers are routine.
  Read-modify-write alone silently loses one of them.
- **The queue.** At most 8 cards are open at once; the rest wait and promote as
  you answer, so a deep branch can't bury you.
- **Scroll anchoring.** The feed is rebuilt on every change and changes land
  *above* where you're reading — a card collapsing, a follow-up inserting. The
  card under your eyes is pinned and the difference absorbed into the scroll.

## Licence

None yet — private.

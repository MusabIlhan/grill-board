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

Two things make it different from a chat prompt:

- **You are never blocked.** Questions queue on a board, not in the conversation.
- **Questions are roomy.** Each card renders full markdown — code, tables,
  tradeoffs — so everything needed to answer is *in* the question.

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
| <kbd>↵</kbd> | Send, or reopen an answered card |
| <kbd>C</kbd> <kbd>X</kbd> <kbd>R</kbd> <kbd>E</kbd> | Write your own · you decide · push back · Claude's take |
| <kbd>M</kbd> <kbd>L</kbd> <kbd>P</kbd> | Tell Claude something · light/dark · palette |

A card you're merely passing over never shows a highlighted choice — a highlight
you didn't put there reads as a decision already made for you.

**Push back** is the one worth knowing about: it tells the session the *question*
is wrong, and it retires and re-asks rather than defending it.

Eight palettes ship (Gruvbox, Catppuccin, Nord, Solarized, Rosé Pine, Everforest,
Tokyo Night, GitHub), light and dark. All 16 combinations were contrast-audited:
every text pair clears WCAG AA, every glyph clears 3:1. Default is Nord dark; the
choice persists across boards.

## How it works

A ~600-line zero-dependency Node server and a single HTML page.

```
board.mjs    server + CLI (serve, add, new, watch, retire, note, status, export)
board.html   the page
SKILL.md     the instructions Claude follows
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

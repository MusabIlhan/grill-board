#!/usr/bin/env bash
# Regenerates docs/grill-board.gif from a real board.
#
#   ./demo/reel.sh ~/.claude/grill-board/<board>/state.json
#
# This exists because the capture step used to live in someone's shell history,
# which is the same as not existing. Everything here is already on a Mac that
# has Chrome: no npm install, no headless browser package.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: ./demo/reel.sh <state.json>" >&2; exit 1; }

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "no Chrome at $CHROME — set CHROME=<path to a chromium binary>" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg" >&2; exit 1; }

node "$HERE/reel.mjs" "$SRC"

# --virtual-time-budget lets the page's own first render settle before the shot;
# without it you get frames of a board mid-paint, which look like a bug.
cd "$HERE/reel"
for f in f*.html; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-color-profile=srgb \
    --window-size=1000,720 --virtual-time-budget=2500 \
    --screenshot="${f%.html}.png" "file://$PWD/$f" >/dev/null 2>&1
done

# A shared 128-colour palette rather than per-frame quantising: the board is
# mostly flat panels, and a palette that shifts between frames makes them shimmer.
mkdir -p "$HERE/../docs"
ffmpeg -y -framerate 1.4 -pattern_type glob -i 'f*.png' \
  -vf "scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$HERE/../docs/grill-board.gif" 2>/dev/null

du -h "$HERE/../docs/grill-board.gif"

#!/bin/bash
# The build protocol, exercised for real: five processes racing for three steps,
# a dependency gate, an ownership check, a steal, per-agent event routing, and
# the handoff from a finished build to a review.
#
#   ./test-build.sh
#
# This is the part of the board that cannot be verified by looking at it.
# Everything else shows up on the page when it breaks; a claim that stopped
# being exclusive looks exactly like one that still is, right up until two
# agents edit the same file. So it gets a test and the rest do not.
set -u
B="$(cd "$(dirname "$0")" && pwd)/board.mjs"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/grill-build.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
S="$ROOT/state.json"
PORT=${PORT:-7896}
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s — %s\n' "$1" "$2"; }
is()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "want [$3] got [$2]"; }

cat <<'JSON' | node "$B" add --state "$S" >/dev/null
[{"title":"Fix at the classifier or the queue?","options":[{"key":"a","label":"Split classifyError"}]},
 {"title":"Repair the 41 rows?","options":[{"key":"a","label":"Backfill"}]},
 {"title":"The class, or this queue?","options":[{"key":"a","label":"The class"}]}]
JSON

# s1 and s3 name the same file on purpose — that is the overlap warning's case.
cat <<'JSON' | node "$B" build --state "$S" >/dev/null
[{"title":"Split classifyError","because":["q1","q3"],"files":["src/classify.ts"]},
 {"title":"Backfill 41 rows","because":["q2"],"files":["scripts/backfill.ts"]},
 {"title":"Cap the retry count","because":["q1"],"files":["src/classify.ts"]},
 {"title":"Regression test","because":["q1"],"needs":["s1"]},
 {"title":"Re-test the callers","because":["q3"],"needs":["s1","s3"]}]
JSON

echo '== race: 5 agents, 3 takeable steps'
for a in w1 w2 w3 w4 w5; do
  ( node "$B" claim --state "$S" --as $a >"$ROOT/$a.out" 2>"$ROOT/$a.err"; echo $? >"$ROOT/$a.rc" ) &
done
wait
won=$(for a in w1 w2 w3 w4 w5; do [ "$(cat "$ROOT/$a.rc")" = 0 ] && head -1 "$ROOT/$a.out" | cut -d' ' -f1; done | sort)
is "3 winners, all distinct" "$(echo "$won" | tr '\n' ' ' | xargs)" "s1 s2 s3"
is "2 losers exit 3"         "$(cat "$ROOT"/w*.rc | grep -c 3)" "2"
is "loser is told why"       "$(grep -l 'nothing takeable' "$ROOT"/w*.out | wc -l | xargs)" "2"
is "overlapping files warn"  "$(grep -h OVERLAP "$ROOT"/w*.err | grep -c 'src/classify.ts')" "1"

echo '== dependency gate'
holder=$(for a in w1 w2 w3 w4 w5; do grep -q '^s1 ' "$ROOT/$a.out" 2>/dev/null && echo $a; done)
node "$B" claim --state "$S" --as w9 --step s4 >"$ROOT/blocked.out" 2>&1; is "blocked step refuses" "$?" "3"
is "names its blocker" "$(cat "$ROOT/blocked.out")" "s4 waits on s1"

echo '== ownership'
node "$B" build --state "$S" --step s1 --status done --as intruder >/dev/null 2>&1; is "non-holder denied" "$?" "1"
node "$B" build --state "$S" --step s1 --status done --as "$holder" >/dev/null;     is "holder allowed"   "$?" "0"
node "$B" claim --state "$S" --as w9 --step s4 >/dev/null 2>&1;                     is "dep done unlocks" "$?" "0"

echo '== steal'
node "$B" claim --state "$S" --as thief --step s2 >/dev/null 2>&1;              is "held step refuses" "$?" "3"
node "$B" claim --state "$S" --as thief --steal s2 >/dev/null 2>"$ROOT/st.err"; is "steal succeeds"    "$?" "0"
is "steal is loud" "$(grep -c 'TAKEN FROM' "$ROOT/st.err")" "1"

echo '== release'
node "$B" release --state "$S" --as thief --step s2 >/dev/null; is "release ok" "$?" "0"
is "back to pending" "$(node "$B" status --state "$S" | grep -c '· s2 Backfill')" "1"
node "$B" claim --state "$S" --as w9 --step s2 >/dev/null 2>&1
node "$B" release --state "$S" --as w9 --step s2 --failed --reason "no such table" >/dev/null
is "failed is signed" "$(node "$B" status --state "$S" | grep 's2 ' | grep -c 'w9')" "1"

echo '== per-agent event routing'
node "$B" claim --state "$S" --as w9 --step s2 >/dev/null 2>&1
cat <<'JSON' | node "$B" change --state "$S" --as w9 >/dev/null
[{"title":"Backfill script","because":["q2"],"summary":"Rewrites 41 rows.","diff":"+ update outbox set state='dead'"}]
JSON
cat <<JSON | node "$B" change --state "$S" --as "$holder" >/dev/null
[{"title":"classifyError split","because":["q1"],"summary":"4xx is terminal.","diff":"+ return 'terminal'"}]
JSON
node "$B" review --state "$S" >/dev/null
node "$B" new --state "$S" --as w9 --mine >/dev/null           # seed both cursors past
node "$B" new --state "$S" --as "$holder" --mine >/dev/null    # the cards themselves
node "$B" serve --state "$S" --port "$PORT" >"$ROOT/serve.log" 2>&1 &
SRV=$!
sleep 1.2
rid=$(node -e "console.log(require('$S').changes.find(c=>c.id==='c1').reviewId)")
curl -s -X POST "http://localhost:$PORT/api/answer" -H 'content-type: application/json' \
  -d "{\"id\":\"$rid\",\"keys\":[\"ok\"]}" >/dev/null
is "verdict reaches the author" "$(node "$B" new --state "$S" --as w9 --mine | grep -c '"changeId": "c1"')" "1"
is "and nobody else"            "$(node "$B" new --state "$S" --as "$holder" --mine | grep -c changeId)" "0"
curl -s -X POST "http://localhost:$PORT/api/ask" -H 'content-type: application/json' \
  -d "{\"id\":\"$rid\",\"kind\":\"simpler\"}" >/dev/null
is "ask on a review card too"   "$(node "$B" new --state "$S" --as w9 --mine | grep -c '"kind": "simpler"')" "1"
is "still nobody else"          "$(node "$B" new --state "$S" --as "$holder" --mine | grep -c simpler)" "0"
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null

echo '== drained, and the handoff to review'
for s in s1 s2 s3 s4; do
  node "$B" claim --state "$S" --as mop --steal $s >/dev/null 2>&1
  node "$B" build --state "$S" --step $s --status done --as mop >/dev/null 2>&1
done
node "$B" claim --state "$S" --as mop --steal s5 >/dev/null 2>&1
node "$B" build --state "$S" --step s5 --status done --as mop >/dev/null 2>&1
node "$B" claim --state "$S" --as mop >"$ROOT/drain.out" 2>&1; is "all done exits 0" "$?" "0"
is "and says so" "$(cat "$ROOT/drain.out")" "every step is done"

# Nobody calls `review`. Settling the LAST step has to send the changes up, or a
# build that finishes ends in silence — the whole failure this exists to
# prevent, and one that is invisible from the page until you go looking.
echo '== a finished build hands itself back'
S2="$ROOT/handoff.json"
echo '[{"title":"Fix it?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S2" >/dev/null
echo '[{"title":"Do the thing","because":["q1"]}]' | node "$B" build --state "$S2" >/dev/null
echo '[{"title":"Did the thing","because":["q1"],"summary":"It is done.","diff":"+ done"}]' \
  | node "$B" change --state "$S2" >/dev/null
node "$B" build --state "$S2" --step s1 --status done >"$ROOT/last.out" 2>&1
is "last step sends changes up" "$(grep -c 'up for review' "$ROOT/last.out")" "1"
is "and flips the phase"        "$(node "$B" status --state "$S2" | grep -c '\[review\]')" "1"

echo '== a build that logged nothing'
S3="$ROOT/empty.json"
echo '[{"title":"Fix it?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S3" >/dev/null
echo '[{"title":"Do the thing","because":["q1"]}]' | node "$B" build --state "$S3" >/dev/null
node "$B" build --state "$S3" --step s1 --status done >"$ROOT/owed.out" 2>&1
# "Everything reviewed" over a board that was shown no code is worse than the
# silence it replaces, so this case must NOT flip the phase.
is "stays in building" "$(node "$B" status --state "$S3" | grep -c '\[building\]')" "1"
is "and says what it owes" "$(grep -c 'NO change has been logged' "$ROOT/owed.out")" "1"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]

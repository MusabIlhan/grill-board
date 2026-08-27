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
SPORT=''   # resolved lazily; freeport is defined below
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s — %s\n' "$1" "$2"; }
is()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "want [$3] got [$2]"; }

# Pressing Start building, which is the only way a plan ever starts. There is
# deliberately no CLI verb for it — a verb an agent can type is a verb an agent
# will type — so the test does exactly what the page does: POST /api/start.
# Every plan in this file goes through here, which is itself the assertion that
# nothing downstream can run without it.
# `PORT + n` is a guess, and on a stranger's machine the guess lands on whatever
# they already run — 8000 and 8001 are the usual casualties, and the symptom is
# a 404 from someone else's server rather than an obvious port clash. Ask the OS
# instead. Node is already required, so this costs nothing new.
freeport() {
  node -e '
    const net = require("net");
    let p = Number(process.argv[1]);
    (function probe() {
      const s = net.createServer();
      s.once("error", () => { p++; probe(); });
      s.once("listening", () => s.close(() => console.log(p)));
      s.listen(p, "127.0.0.1");
    })();
  ' "$1"
}

press() {
  local st="$1" pt pid out i
  pt=$(freeport "${2:-$((PORT + 20))}")
  node "$B" serve --state "$st" --port "$pt" --host 127.0.0.1 >/dev/null 2>&1 &
  pid=$!
  for i in $(seq 1 40); do
    curl -sf "http://localhost:$pt/api/state" >/dev/null 2>&1 && break
    sleep 0.1
  done
  out=$(curl -s -X POST "http://localhost:$pt/api/start" -H 'content-type: application/json' -d '{}')
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  printf '%s' "$out"
}

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

# A plan that begins on its own is a plan nobody agreed to. Posting it must put
# it up and stop there — and "stop" has to mean the work is refused, not merely
# that the page draws a button, or the rule is decoration an agent walks past.
echo '== nothing starts until they press the button'
is "a posted plan is not running" "$(node "$B" status --state "$S" | grep -c '\[planned\]')" "1"
node "$B" claim --state "$S" --as early >"$ROOT/early.out" 2>&1
is "a worker that spun up early waits" "$?" "3"
is "and is told what it is waiting for" "$(grep -c 'press Start building' "$ROOT/early.out")" "1"
# The other way work starts. `claim` is the front door; moving a step by hand is
# the side one, and both have to be shut or only the polite path is gated.
node "$B" build --state "$S" --step s1 --status running >"$ROOT/earlystep.out" 2>&1
is "a step cannot be moved either" "$?" "1"

# The button opens a window that never existed before: a plan sitting in front of
# someone who can argue with it. "Cut step 3" has to leave two steps, not five.
echo '[{"title":"Split classifyError","because":["q1","q3"],"files":["src/classify.ts"]},
 {"title":"Backfill 41 rows","because":["q2"],"files":["scripts/backfill.ts"]},
 {"title":"Cap the retry count","because":["q1"],"files":["src/classify.ts"]},
 {"title":"Regression test","because":["q1"],"needs":["s1"]},
 {"title":"Re-test the callers","because":["q3"],"needs":["s1","s3"]}]' \
  | node "$B" build --state "$S" >"$ROOT/repost.out" 2>&1
is "an unstarted plan can be rewritten" "$(grep -c 'replacing the 5 posted before' "$ROOT/repost.out")" "1"
is "and does not accumulate steps"      "$(node "$B" status --state "$S" | grep -c '^    · s')" "5"

is "pressing it starts the build" "$(press "$S" | grep -c '"ok":true')" "1"
is "and the board says building"  "$(node "$B" status --state "$S" | grep -c '\[building\]')" "1"
is "the session is woken to begin" "$(node "$B" new --state "$S" | grep -c '"type": "start"')" "1"

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

SPORT=$(freeport "$PORT")
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
node "$B" serve --state "$S" --port "$SPORT" --host 127.0.0.1 >"$ROOT/serve.log" 2>&1 &
SRV=$!
sleep 1.2
rid=$(node -e "console.log(require('$S').changes.find(c=>c.id==='c1').reviewId)")
curl -s -X POST "http://localhost:$SPORT/api/answer" -H 'content-type: application/json' \
  -d "{\"id\":\"$rid\",\"keys\":[\"ok\"]}" >/dev/null
is "verdict reaches the author" "$(node "$B" new --state "$S" --as w9 --mine | grep -c '"changeId": "c1"')" "1"
is "and nobody else"            "$(node "$B" new --state "$S" --as "$holder" --mine | grep -c changeId)" "0"
curl -s -X POST "http://localhost:$SPORT/api/ask" -H 'content-type: application/json' \
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
press "$S2" >/dev/null
echo '[{"title":"Did the thing","because":["q1"],"summary":"It is done.","diff":"+ done"}]' \
  | node "$B" change --state "$S2" >/dev/null
node "$B" build --state "$S2" --step s1 --status done >"$ROOT/last.out" 2>&1
is "last step sends changes up" "$(grep -c 'up for review' "$ROOT/last.out")" "1"
is "and flips the phase"        "$(node "$B" status --state "$S2" | grep -c '\[review\]')" "1"

echo '== the handback: what one agent decided, read by another'
S4="$ROOT/handback2.json"
echo '[{"title":"Lemma or surface?","options":[{"key":"a","label":"Lemma"}]}]' | node "$B" add --state "$S4" >/dev/null
echo '[{"title":"Lexeme identity","because":["q1"]},{"title":"Typecheck","because":["q1"]}]' \
  | node "$B" build --state "$S4" >/dev/null
press "$S4" >/dev/null
node "$B" claim --state "$S4" --as backfill --step s1 >/dev/null
# Recording is not finishing: a call made mid-step must be sayable without
# ending the step, or it gets reconstructed at the end when the reason has faded.
node "$B" build --state "$S4" --as backfill --step s1 \
  --decided "Matched on (lemma, pos), not surface" --decided "Partial index — the table is hot" \
  --flag "position is written from here" >"$ROOT/rec.out" 2>&1
is "records without moving"  "$(grep -c 'status unchanged: running' "$ROOT/rec.out")" "1"
is "repeats accumulate"      "$(node "$B" decisions --state "$S4" 2>/dev/null | grep -c 'decided')" "2"
is "a flag is its own thing" "$(node "$B" decisions --state "$S4" 2>/dev/null | grep -c 'FLAG')" "1"
# Only the holder records, same as moving — a decision under the wrong name is
# worse than no decision at all.
node "$B" build --state "$S4" --as intruder --step s1 --decided "mine now" >/dev/null 2>&1
is "non-holder cannot record" "$?" "1"

node "$B" build --state "$S4" --as backfill --step s1 --status done >/dev/null 2>&1
# The lead is not watching the board; it is waiting on events. The handback has
# to ride the wake, or fanning out costs more to supervise than to do.
node "$B" new --state "$S4" >"$ROOT/lead.json"
is "the lead is woken by the step" "$(grep -c '"type": "step"' "$ROOT/lead.json")" "1"
is "and the wake carries the why"  "$(grep -c 'Partial index' "$ROOT/lead.json")" "1"
is "workers are not"               "$(node "$B" new --state "$S4" --as backfill --mine | grep -c '"type": "step"')" "0"

node "$B" claim --state "$S4" --as tests --step s2 >/dev/null
node "$B" build --state "$S4" --as tests --step s2 --status done >"$ROOT/bare.out" 2>&1
is "a bare settle warns"    "$(grep -c 'no --decided' "$ROOT/bare.out")" "1"
is "and is named as a gap"  "$(node "$B" decisions --state "$S4" 2>/dev/null | grep -c 'nothing recorded')" "1"
is "one agent, one view"    "$(node "$B" decisions --state "$S4" --as backfill 2>/dev/null | grep -c '^s2')" "0"

echo '== a build that logged nothing'
S3="$ROOT/empty.json"
echo '[{"title":"Fix it?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S3" >/dev/null
echo '[{"title":"Do the thing","because":["q1"]}]' | node "$B" build --state "$S3" >/dev/null
press "$S3" >/dev/null
node "$B" build --state "$S3" --step s1 --status done >"$ROOT/owed.out" 2>&1
# "Everything reviewed" over a board that was shown no code is worse than the
# silence it replaces, so this case must NOT flip the phase.
is "stays in building" "$(node "$B" status --state "$S3" | grep -c '\[building\]')" "1"
is "and says what it owes" "$(grep -c 'NO change has been logged' "$ROOT/owed.out")" "1"

echo '== the checklist comes before the review'
S5="$ROOT/testing.json"
echo '[{"title":"Root?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S5" >/dev/null
echo '[{"title":"Do it","because":["q1"]}]' | node "$B" build --state "$S5" >/dev/null
press "$S5" >/dev/null
echo '[{"title":"The change","because":["q1"],"summary":"x","diff":"@@ -1 +1 @@\n-a\n+b"}]' \
  | node "$B" change --state "$S5" >/dev/null
printf '%s\n' '[{"title":"Try A","how":"Do A.","expect":"A happens.","because":["c1"]},{"title":"Try B","how":"Do B.","expect":"B happens.","because":["c1"]}]' \
  | node "$B" test --state "$S5" >/dev/null 2>&1
node "$B" build --state "$S5" --step s1 --status done >"$ROOT/settle.out" 2>&1
is "settling puts the checklist up, not the review" "$(grep -c 'things to test' "$ROOT/settle.out")" "1"
is "the board says testing"  "$(node "$B" status --state "$S5" | grep -c '\[testing\]')" "1"
# The whole point of testing first: a verdict on code that turns out not to work
# is a verdict that has to be asked for all over again.
is "no change is out for review yet" "$(node "$B" status --state "$S5" | grep -c 'not sent for review')" "1"

PT=$(freeport $((PORT + 2)))
node "$B" serve --state "$S5" --port "$PT" --host 127.0.0.1 >/dev/null 2>&1 &
T5=$!; sleep 1
tick() { curl -s -X POST "http://localhost:$PT/api/answer" -H 'content-type: application/json' -d "$1" >/dev/null; }
tick '{"id":"q2","keys":["pass"]}'
tick '{"id":"q3","keys":["fail"],"text":"nothing happened"}'
# A FAILED test has to HOLD the review back, not merely be recorded. This is the
# regression that shipped once already: "resolved" counted a failure as done,
# so one broken thing still sent every change off to be approved.
is "a failure holds the review"  "$(node "$B" status --state "$S5" | grep -c '\[testing\]')" "1"
is "and the change stays unsent" "$(node "$B" status --state "$S5" | grep -c 'not sent for review')" "1"

# `review` by hand is the other way into the review, and the rule has to hold on
# both or the README's promise is only true of the path nobody types.
node "$B" review --state "$S5" >"$ROOT/early-review.out" 2>&1
is "review by hand is held too" "$?" "1"
is "and it names what is outstanding" "$(grep -c 'not clear yet' "$ROOT/early-review.out")" "1"

node "$B" test --state "$S5" --retry t2 --note "the handler was never bound" >/dev/null
is "the retry reopens the same card" "$(node "$B" status --state "$S5" | grep -c 'attempt 2')" "1"
is "and it remembers what failed"    "$(curl -s "http://localhost:$PT/api/state" | grep -c 'nothing happened')" "1"
tick '{"id":"q3","keys":["pass"]}'
# Minted by the answer itself rather than by the agent draining later — a
# checklist finished at midnight must not sit there until a session wakes up.
is "clearing the list releases the review" "$(node "$B" status --state "$S5" | grep -c '\[review\]')" "1"
is "and the change is out"                 "$(node "$B" status --state "$S5" | grep -c 'awaiting review')" "1"
kill "$T5" 2>/dev/null; wait "$T5" 2>/dev/null

echo '== a build with nothing to try'
S6="$ROOT/notests.json"
echo '[{"title":"Root?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S6" >/dev/null
echo '[{"title":"Do it","because":["q1"]}]' | node "$B" build --state "$S6" >/dev/null
press "$S6" >/dev/null
echo '[{"title":"C","because":["q1"],"summary":"x","diff":"@@ -1 +1 @@\n-a\n+b"}]' | node "$B" change --state "$S6" >/dev/null
node "$B" build --state "$S6" --step s1 --status done >"$ROOT/nt.out" 2>&1
# Not an error — some builds genuinely have nothing to run by hand — but it is
# the default you have to argue out of, so it is said rather than passed over.
is "it says nobody ran it"    "$(grep -c 'no test authored' "$ROOT/nt.out")" "1"
is "and still reaches review" "$(node "$B" status --state "$S6" | grep -c '\[review\]')" "1"

# The board is writable by whoever can reach it, so "who can reach it" is not a
# detail. These four cases are the whole rule, and the last two are the escape
# hatches — a rule with no way out strands anyone on a LAN they trust.
echo '== the board does not go on the network naked'
S7="$ROOT/tok.json"
echo '[{"title":"Root?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S7" >/dev/null
P7=$(freeport $((PORT + 10)))
node "$B" serve --state "$S7" --port "$P7" >"$ROOT/tok.out" 2>&1 &
T7=$!; for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$P7/" && break; sleep 0.1; done
TOK=$(awk '/^  token /{print $2}' "$ROOT/tok.out")
is "binding past loopback mints one"  "$([ -n "$TOK" ] && echo yes)" "yes"
is "and says why"                     "$(grep -c 'not loopback' "$ROOT/tok.out")" "1"
is "an untokened read is refused"     "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$P7/api/state")" "401"
is "the token gets you in"            "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$P7/api/state?t=$TOK")" "200"
is "so does a bearer header"          "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "http://localhost:$P7/api/state")" "200"
# The URL already open on a phone must survive a restart, or the token is a
# feature that breaks the feature it is protecting.
kill "$T7" 2>/dev/null; wait "$T7" 2>/dev/null
node "$B" serve --state "$S7" --port "$P7" --adopt >"$ROOT/tok2.out" 2>&1 &
T7=$!; for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$P7/" && break; sleep 0.1; done
is "and it survives a restart" "$(awk '/^  token /{print $2}' "$ROOT/tok2.out")" "$TOK"
kill "$T7" 2>/dev/null; wait "$T7" 2>/dev/null

S8="$ROOT/tok-loop.json"
echo '[{"title":"Root?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S8" >/dev/null
P8=$(freeport $((PORT + 11)))
node "$B" serve --state "$S8" --port "$P8" --host 127.0.0.1 >"$ROOT/loop.out" 2>&1 &
T8=$!; for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$P8/" && break; sleep 0.1; done
is "loopback stays open"       "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$P8/api/state")" "200"
kill "$T8" 2>/dev/null; wait "$T8" 2>/dev/null

S9="$ROOT/tok-off.json"
echo '[{"title":"Root?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S9" >/dev/null
P9=$(freeport $((PORT + 12)))
node "$B" serve --state "$S9" --port "$P9" --no-token >"$ROOT/off.out" 2>&1 &
T9=$!; for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$P9/" && break; sleep 0.1; done
is "--no-token is a real way out"  "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$P9/api/state")" "200"
kill "$T9" 2>/dev/null; wait "$T9" 2>/dev/null

# The gateway cannot use the bind rule: it binds loopback and is then TUNNELLED,
# which no address check can see. So it mints unconditionally.
echo '== the gateway is public by definition'
PG=$(freeport $((PORT + 13)))
node "$B" gateway --port "$PG" >"$ROOT/gw.out" 2>&1 &
TG=$!; for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$PG/" && break; sleep 0.1; done
is "it mints without being asked"   "$([ -n "$(awk '/^  token /{print $2}' "$ROOT/gw.out")" ] && echo yes)" "yes"
is "and refuses an untokened read"  "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PG/api/state")" "401"
kill "$TG" 2>/dev/null; wait "$TG" 2>/dev/null

# The README claims Node 18+. Claiming is not enforcing, and the failure it
# prevents — a stack trace from the middle of a 2,100-line file — reads to a
# stranger as a broken tool rather than an old runtime.
echo '== an old Node is told, not crashed into'
sed 's/^const nodeMajor = .*/const nodeMajor = 16;/' "$B" > "$ROOT/old.mjs"
node "$ROOT/old.mjs" status --state "$S7" >"$ROOT/old.out" 2>&1
is "it exits nonzero"     "$?" "1"
is "and names the floor"  "$(grep -c 'needs Node 18 or newer' "$ROOT/old.out")" "1"
is "and how to fix it"    "$(grep -c 'nvm install' "$ROOT/old.out")" "1"

# The demo is board.html plus an injected shim, generated rather than forked —
# and this is what keeps that true. A change to the page that nobody regenerated
# is a red test here instead of a demo quietly showing last month's board.
echo '== the demo has not rotted'
node "$(dirname "$B")/demo/build.mjs" --check >"$ROOT/demo.out" 2>&1
is "demo/index.html is current" "$?" "0"
is "the state is injected once" "$(grep -c 'window.__DEMO_STATE__ =' "$(dirname "$B")/demo/index.html")" "1"
is "and it is the real page"    "$(grep -c 'id=\"buildPanel\"' "$(dirname "$B")/demo/index.html")" "1"
# A token or a home directory baked into a page served on the public internet is
# the one mistake here that cannot be taken back.
is "no token baked in"   "$(grep -cE '\?t=[a-z0-9]{20}' "$(dirname "$B")/demo/index.html")" "0"
# JSON.stringify does not escape `</script>`, and the state contains one the
# moment a review card quotes the generator. The tag then closes mid-object and
# the page renders an empty board with an offline banner. It shipped once; this
# is why it cannot again.
is "a quoted script tag cannot end the state" \
  "$(awk '/window.__DEMO_STATE__ =/{n=gsub(/<\/script>/,""); print n; exit}' "$(dirname "$B")/demo/index.html")" "1"
is "no home path baked in" "$(grep -c "$HOME" "$(dirname "$B")/demo/index.html")" "0"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]

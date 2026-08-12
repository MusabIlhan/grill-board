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

echo '== the handback: what one agent decided, read by another'
S4="$ROOT/handback2.json"
echo '[{"title":"Lemma or surface?","options":[{"key":"a","label":"Lemma"}]}]' | node "$B" add --state "$S4" >/dev/null
echo '[{"title":"Lexeme identity","because":["q1"]},{"title":"Typecheck","because":["q1"]}]' \
  | node "$B" build --state "$S4" >/dev/null
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
node "$B" build --state "$S3" --step s1 --status done >"$ROOT/owed.out" 2>&1
# "Everything reviewed" over a board that was shown no code is worse than the
# silence it replaces, so this case must NOT flip the phase.
is "stays in building" "$(node "$B" status --state "$S3" | grep -c '\[building\]')" "1"
is "and says what it owes" "$(grep -c 'NO change has been logged' "$ROOT/owed.out")" "1"

# The card budget. A refusal is loud when it fires, so the checks that matter
# are the quiet halves: that the REST of the batch still landed, and that a card
# which merely looks short still gets counted where it actually spends — in the
# option details, which are read last and are the natural place to hide overflow.
echo '== the card budget'
S5="$ROOT/budget.json"
cat <<'JSON' | node "$B" add --state "$S5" >"$ROOT/bud.out" 2>"$ROOT/bud.err"
[{"title":"Legal","context":"One.\n\nTwo.\n\n| a | b |\n|---|---|\n| 1 | 2 |","options":[{"label":"x"}]},
 {"title":"Four paragraphs and two tables","context":"One.\n\nTwo.\n\n| a |\n|---|\n\nThree.\n\n| b |\n|---|\n\nFour.","options":[{"label":"y"}]},
 {"title":"Also legal","context":"Prose.","options":[{"label":"z"}]}]
JSON
is "over-budget card refused"  "$(grep -c 'REFUSED' "$ROOT/bud.err")" "1"
is "the rest of the batch lands" "$(grep -c '^added 2: q1 q2' "$ROOT/bud.out")" "1"
is "names which limit broke"   "$(grep -c '4 paragraphs, max 3 · 2 figures, max 1' "$ROOT/bud.err")" "1"
is "says split, not trim"      "$(grep -c 'more than one thing in it' "$ROOT/bud.err")" "1"
# The answer to "how do I know before I hit it": every accepted card reports
# where it landed, so calibration needs no second command and no discipline.
is "accepted cards report size" "$(grep -cE '^  q[12] +[0-9]+p [0-9]+f' "$ROOT/bud.out")" "2"

# A short body with fat option details is the loophole q12 closed. It must be
# refused on characters even though it is one paragraph and no figure.
node -e 'console.log(JSON.stringify([{title:"Short body, fat options",context:"One line.",
  options:[{label:"a",detail:"x".repeat(1100)},{label:"b",detail:"y".repeat(1100)}]}]))' >"$ROOT/fat.json"
node "$B" add --state "$S5" --file "$ROOT/fat.json" >/dev/null 2>"$ROOT/fat.err"
is "options count toward the ceiling" "$(grep -c 'characters, max 2000' "$ROOT/fat.err")" "1"

# One figure, not three paragraphs and two figures: a code block is one thing to
# look at however many blank lines are inside it.
cat <<'JSON' | node "$B" add --state "$S5" >"$ROOT/fence.out" 2>&1
[{"title":"Fenced block with a gap inside","context":"Prose.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nMore.","options":[{"label":"z"}]}]
JSON
is "a fence with blanks is one figure" "$(grep -cE '^  q[0-9]+ +2p 1f' "$ROOT/fence.out")" "1"

# The gate. Its whole point is that you are never left with nothing to answer,
# so the check is as much about what stays OPEN as about what is held back.
echo '== a card that waits on another'
S6="$ROOT/gate.json"
echo '[{"title":"Which store wins?","context":"a","options":[{"key":"a","label":"x"}]}]' \
  | node "$B" add --state "$S6" >/dev/null
cat <<'JSON' | node "$B" add --state "$S6" >/dev/null
[{"title":"How do we migrate it?","parentId":"q1","needs":["q1"],"context":"meaningless until q1 lands","options":[{"key":"a","label":"y"}]},
 {"title":"Unrelated, answerable now","context":"b","options":[{"key":"a","label":"z"}]},
 {"title":"Waits on a typo","needs":["q99"],"context":"c","options":[{"key":"a","label":"w"}]}]
JSON
state() { node -e "const s=require('$S6');console.log((s.questions.find(q=>q.id==='$1')||{}).status)"; }
is "gated card is held"        "$(state q2)" "queued"
is "unrelated card stays open" "$(state q3)" "open"
# A typo must degrade to an ungated card, never to one that is invisible for
# ever — there is no way to find or unstick a card that never renders.
is "an unknown id does not gate" "$(state q4)" "open"

node "$B" serve --state "$S6" --port "$((PORT+1))" >"$ROOT/gate-serve.log" 2>&1 &
GSRV=$!
sleep 1.2
curl -s -X POST "http://localhost:$((PORT+1))/api/answer" -H 'content-type: application/json' \
  -d '{"id":"q1","keys":["a"]}' >/dev/null
is "answering the dep releases it" "$(state q2)" "open"
kill "$GSRV" 2>/dev/null; wait "$GSRV" 2>/dev/null

# A review card is a card. The diff is exempt because it is the artifact under
# review, so the prose is where the rule has to bite — and a summary too long is
# not "write less", it is a change that is really several changes.
echo '== the budget on a review card'
S7="$ROOT/rev.json"
echo '[{"title":"Fix it?","options":[{"key":"a","label":"Yes"}]}]' | node "$B" add --state "$S7" >/dev/null
echo '[{"title":"Do it","because":["q1"]}]' | node "$B" build --state "$S7" >/dev/null
node -e 'console.log(JSON.stringify([
  {title:"Normal",because:["q1"],summary:"One.\n\nTwo.",risk:"A guess.",diff:"--- a/x\n+++ b/x\n+ one"},
  {title:"Summary describing four things",because:["q1"],summary:"One.\n\nTwo.\n\nThree.\n\nFour.",diff:"+ small"},
  {title:"Honest but large",because:["q1"],summary:"One thing.",diff:"--- a/y\n+++ b/y\n"+Array.from({length:150},(_,i)=>"+ l"+i).join("\n")}
]))' >"$ROOT/ch.json"
node "$B" change --state "$S7" --file "$ROOT/ch.json" >"$ROOT/ch.out" 2>"$ROOT/ch.err"
is "over-budget change refused"  "$(grep -c 'REFUSED' "$ROOT/ch.err")" "1"
is "the others still log"        "$(grep -c 'logged c1 c2' "$ROOT/ch.out")" "1"
is "and it says log it as more"  "$(grep -c 'MORE' "$ROOT/ch.err")" "1"
# A limit here would refuse the honest single-function rewrite, so a big diff
# must warn and land. If this ever starts refusing, that is the regression.
is "a big diff warns"            "$(grep -c '150-line diff' "$ROOT/ch.err")" "1"
is "and lands anyway"            "$(node "$B" status --state "$S7" | grep -c 'Honest but large')" "1"

# The example is the real spec. An agent copies the shape of the worked card in
# SKILL.md far more reliably than it follows the rule written above it — so an
# example that drifts over budget teaches the wrong card to everyone who reads
# it, and nothing else would notice, because prose does not fail a build. This
# runs the SHIPPED counter over the JSON blocks in SKILL.md.
echo '== SKILL.md practises what it documents'
cat > "$ROOT/skillcheck.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
const B = await import(process.argv[2]);
const md = readFileSync(process.argv[3], 'utf8');
const bad = [];
let n = 0;
for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
  let o; try { o = JSON.parse(m[1]); } catch { continue; }
  for (const c of (Array.isArray(o) ? o : [o])) {
    if (!c || !c.title) continue;
    const isChange = 'summary' in c || 'diff' in c;
    const over = B.overBudget(isChange ? B.measureChange(c) : B.measureCard(c));
    n++;
    if (over.length) bad.push(`"${c.title.slice(0, 40)}" ${over.join(' · ')}`);
  }
}
console.log(!n ? 'NO EXAMPLES FOUND' : bad.length ? bad.join('; ') : `${n} legal`);
EOF
HERE="$(cd "$(dirname "$0")" && pwd)"
is "every worked example is legal" \
  "$(node "$ROOT/skillcheck.mjs" "$B" "$HERE/SKILL.md" | grep -c 'legal')" "1"
# Guard the guard: if the extractor stops finding examples it reports success
# forever, which is the one failure a green tick cannot show you.
is "and there are examples to check" \
  "$(node "$ROOT/skillcheck.mjs" "$B" "$HERE/SKILL.md" | grep -c 'NO EXAMPLES')" "0"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]

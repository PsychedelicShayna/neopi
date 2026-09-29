#!/usr/bin/env bash
# Private fake-model orchestrator proof. Every model-facing pane is checked for
# provider=fake before prompts; all keyboard input uses tmux -L ctl-live.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
NPI=${NPI:-$ROOT/dist/npi}
LOG=${LOG:-/tmp/control-live.log}
if [[ ! -x $NPI ]] || ! command -v tmux >/dev/null || ! command -v bun >/dev/null; then
	echo "skip: need NPI, tmux, and bun" | tee "$LOG"
	exit 0
fi
# shellcheck source=fake-model.sh
source "$HERE/fake-model.sh"
DIR=$(mktemp -d)
mkdir -p "$DIR/ctl"
export PI_CONTROL_DIR=$DIR/ctl PI_CODING_AGENT_DIR=$DIR FAKE_DRIVE_TARGETS=%1,%2
SOCK=ctl-live-$$
start_fake_model "$DIR"
trap 'kill $FAKE_PID 2>/dev/null || true; tmux -L $SOCK kill-server 2>/dev/null || true' EXIT
tmux -f /dev/null -L "$SOCK" new-session -d -x 220 -y 50 -s ctl
tmux -L "$SOCK" split-window -h
tmux -L "$SOCK" split-window -v -t ctl:0.1
for pane in 0 1 2; do
	tmux -L "$SOCK" send-keys -t "ctl:0.$pane" "env PI_CONTROL_DIR=$PI_CONTROL_DIR PI_CODING_AGENT_DIR=$DIR $NPI --model fake/echo" Enter
done
ids=$(tmux -L "$SOCK" list-panes -t ctl:0 -F '#{pane_index} #{pane_id}')
echo "$ids" >"$LOG.panes"
for _ in $(seq 1 160); do
	ready=$("$NPI" ctl list --json 2>/dev/null | bun -e 'const s = JSON.parse(await Bun.stdin.text()).sessions ?? []; console.log(s.filter(x => x.snapshot?.ready).length)' || echo 0)
	[[ $ready -ge 3 ]] && break
	sleep 0.25
done
orch=$(awk '$1==0{print $2}' "$LOG.panes")
t1=$(awk '$1==1{print $2}' "$LOG.panes")
t2=$(awk '$1==2{print $2}' "$LOG.panes")
if [[ $t1 != %1 || $t2 != %2 || $ready -lt 3 ]]; then
	echo "fail: expected three ready private panes, got $ready / $t1 $t2" | tee "$LOG"
	exit 1
fi
for target in "$orch" "$t1" "$t2"; do
	"$NPI" ctl "$target" rpc get_state '{}' >"$LOG.pre.$target"
	require_fake_provider "$LOG.pre.$target"
done
: >"$LOG"
check() {
	local label=$1
	local response=$2
	if ! bun -e 'process.exit(JSON.parse(await Bun.stdin.text()).success===true?0:1)' <"$response"; then
		echo "FAIL $label: $(cat "$response")" | tee -a "$LOG"
		exit 1
	fi
	echo "PASS $label: $(cat "$response" | cut -c1-220)" >>"$LOG"
}
"$NPI" ctl "$orch" send "DRIVE both other panes" >"$LOG.drive"
check "orchestrator DRIVE request" "$LOG.drive"
for _ in $(seq 1 80); do
	if tmux -L "$SOCK" capture-pane -p -t ctl:0.1 | grep -q '╰─ x' &&
		tmux -L "$SOCK" capture-pane -p -t ctl:0.2 | grep -q '╰─ y'; then break; fi
	sleep 0.25
done
tmux -L "$SOCK" capture-pane -p -t ctl:0.1 | grep '╰─ x' | tee -a "$LOG"
tmux -L "$SOCK" capture-pane -p -t ctl:0.2 | grep '╰─ y' | tee -a "$LOG"
"$NPI" ctl "$orch" send "SUBMIT the first composer" >"$LOG.submit"
check "orchestrator SUBMIT request" "$LOG.submit"
for _ in $(seq 1 80); do
	"$NPI" ctl "$t1" rpc get_entries '{}' >"$LOG.entries"
	if grep -Eq '"text"[[:space:]]*:[[:space:]]*"x"' "$LOG.entries"; then break; fi
	sleep 0.25
done
grep -Eo '"text"[[:space:]]*:[[:space:]]*"x"' "$LOG.entries" | tee -a "$LOG"
"$NPI" ctl "$orch" send "STATE of first pane" >"$LOG.state"
check "orchestrator STATE request" "$LOG.state"
for _ in $(seq 1 80); do
	if tmux -L "$SOCK" capture-pane -p -t ctl:0.0 | grep -q 'op="state"'; then break; fi
	sleep 0.25
done
tmux -L "$SOCK" capture-pane -p -t ctl:0.0 | grep 'op="state"' | tee -a "$LOG"
"$NPI" ctl "$t1" send "CHOOSE a pane" >"$LOG.choose"
check "target ask request" "$LOG.choose"
dialog=""
for _ in $(seq 1 80); do
	"$NPI" ctl "$t1" rpc dialogs '{}' >"$LOG.dialogs"
	dialog=$(bun -e 'let r=JSON.parse(await Bun.stdin.text()); console.log(r.data?.dialogs?.find(d=>d.answerable)?.dialogId??"")' <"$LOG.dialogs")
	[[ -n $dialog ]] && break
	sleep 0.25
done
if [[ -z $dialog ]]; then
	echo "FAIL ask multiple-choice UI never opened" | tee -a "$LOG"
	exit 1
fi
echo "ask dialog $dialog $(bun -e 'let r=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(r.data?.dialogs?.[0]))' <"$LOG.dialogs")" | tee -a "$LOG"
"$NPI" ctl "$orch" send "ANSWER $dialog" >"$LOG.answer"
check "orchestrator ANSWER request" "$LOG.answer"
for _ in $(seq 1 80); do
	"$NPI" ctl "$t1" rpc dialogs '{}' >"$LOG.dialogs.after"
	if grep -Eq '"dialogs"[[:space:]]*:[[:space:]]*\[\]' "$LOG.dialogs.after"; then break; fi
	sleep 0.25
done
grep -Eo '"dialogs"[[:space:]]*:[[:space:]]*\[\]' "$LOG.dialogs.after" | tee -a "$LOG"
"$NPI" ctl "$t1" rpc get_messages '{}' >"$LOG.answered-messages"
if ! grep -q 'Second pane' "$LOG.answered-messages"; then
	echo "FAIL ask answer was not recorded as Second pane" | tee -a "$LOG"
	exit 1
fi
echo 'ask choice: Second pane' | tee -a "$LOG"
"$NPI" ctl "$t2" rpc state '{}' >"$LOG.before-human"
baseline=$(bun -e 'let r=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({human:r.data.revisions.human,draft:r.data.revisions.draft}))' <"$LOG.before-human")
tmux -L "$SOCK" send-keys -t ctl:0.2 'H'
for _ in $(seq 1 80); do
	"$NPI" ctl "$t2" rpc draft_get '{}' >"$LOG.human-draft"
	if grep -Eq '"text"[[:space:]]*:[[:space:]]*"yH"' "$LOG.human-draft"; then break; fi
	sleep 0.25
done
grep -Eo '"text"[[:space:]]*:[[:space:]]*"yH"' "$LOG.human-draft" | tee -a "$LOG"
"$NPI" ctl "$t2" rpc draft_insert "$(bun -e 'let o=JSON.parse(process.argv[1]);console.log(JSON.stringify({text:"injected",if:o}))' "$baseline")" >"$LOG.backoff" || true
grep '⌁ .*backed off' "$LOG.backoff" | tee -a "$LOG"
tmux -L "$SOCK" capture-pane -p -t ctl:0.2 | grep '⌁ .*backed off' | tee -a "$LOG"
"$NPI" ctl "$t2" rpc draft_get '{}' >"$LOG.final-draft"
grep -Eo '"text"[[:space:]]*:[[:space:]]*"yH"' "$LOG.final-draft" | tee -a "$LOG"
oversize=$(bun -e 'console.log(JSON.stringify({keys:[{text:"Z"},{text:"a".repeat(4096)}]}))')
"$NPI" ctl "$t2" rpc keys "$oversize" >"$LOG.oversize" || true
grep '"code": "frame_too_large"' "$LOG.oversize" | tee -a "$LOG"
"$NPI" ctl "$t2" rpc draft_get '{}' >"$LOG.after-oversize"
grep -Eo '"text"[[:space:]]*:[[:space:]]*"yH"' "$LOG.after-oversize" | tee -a "$LOG"
echo "PASS orchestrator drove typed drafts, submitted, read state, answered ask and backed off to human" | tee -a "$LOG"

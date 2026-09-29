#!/usr/bin/env bash
# Orchestrator proof (#171) on a private tmux socket and a private control
# registry. Pane 0 is the orchestrator; its model is a local fake that answers
# "DRIVE" with two ctl tool calls, typing x into pane 1 and y into pane 2.
# capture-pane must show both letters in the target composers. /live is then
# attempted in pane 0 and its status line is recorded (it needs a Codex OAuth
# credential for the voice transport; the fake cannot provide one).
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
SOCK=ctl-live
start_fake_model "$DIR"
trap 'kill $FAKE_PID 2>/dev/null || true; tmux -L $SOCK kill-server 2>/dev/null || true' EXIT
tmux -L "$SOCK" kill-server 2>/dev/null || true
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
if [[ $t1 != %1 || $t2 != %2 ]]; then
	echo "fail: expected target panes %1 and %2, got $t1 $t2" | tee "$LOG"
	exit 1
fi
"$NPI" ctl "$orch" rpc get_state '{}' >"$LOG.pre" || true
require_fake_provider "$LOG.pre"
"$NPI" ctl "$orch" send "DRIVE both other panes" || true
for _ in $(seq 1 80); do
	if tmux -L "$SOCK" capture-pane -p -t ctl:0.1 | grep -q "╰─ x" && tmux -L "$SOCK" capture-pane -p -t ctl:0.2 | grep -q "╰─ y"; then
		break
	fi
	sleep 0.25
done
"$NPI" ctl "$orch" slash "/live" >"$LOG.live" 2>&1 || true
sleep 2
{
	echo "binary $NPI"
	echo "sha256 $(sha256sum "$NPI" | cut -d' ' -f1)"
	echo "orchestrator $orch  targets $t1 $t2"
	echo "=== list ==="
	"$NPI" ctl list || true
	echo "=== pane 0 (orchestrator) ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.0 || true
	echo "=== pane 1 ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.1 || true
	echo "=== pane 2 ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.2 || true
	echo "=== fake requests ==="
	cat "$DIR/fake.log" || true
} | tee "$LOG"
if ! tmux -L "$SOCK" capture-pane -p -t ctl:0.1 | grep -q "╰─ x" || ! tmux -L "$SOCK" capture-pane -p -t ctl:0.2 | grep -q "╰─ y"; then
	echo "fail: the orchestrator's ctl tool calls did not reach both target composers" | tee -a "$LOG"
	exit 1
fi
echo "pass: one orchestrator pane drove two other panes" | tee -a "$LOG"

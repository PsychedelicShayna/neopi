#!/usr/bin/env bash
# Real-pane control-socket check (#171). Private tmux socket only.
# Skips unless dist/npi (or $NPI) and tmux exist.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NPI=${NPI:-$ROOT/dist/npi}
LOG=${LOG:-/tmp/control-tmux-e2e.log}
if [[ ! -x $NPI ]] || ! command -v tmux >/dev/null; then
	echo "skip: need an executable NPI and tmux" | tee "$LOG"
	exit 0
fi
SOCK=ctl-e2e
tmux -L "$SOCK" kill-server 2>/dev/null || true
tmux -f /dev/null -L "$SOCK" new-session -d -x 200 -y 50 -s ctl
tmux -L "$SOCK" split-window -h
tmux -L "$SOCK" send-keys -t ctl:0.0 "$NPI" Enter
tmux -L "$SOCK" send-keys -t ctl:0.1 "$NPI" Enter

ready=0
for _ in $(seq 1 80); do
	if "$NPI" ctl list --json 2>/dev/null | grep -q instanceId; then
		ready=1
		break
	fi
	sleep 0.25
done
{
	echo "=== list ==="
	"$NPI" ctl list || true
	echo "=== pane 0 ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.0 || true
	echo "=== pane 1 ==="
	tmux -L "$SOCK" capture-pane -p -t ctl:0.1 || true
} | tee "$LOG"

if [[ $ready -ne 1 ]]; then
	echo "fail: sessions did not publish" | tee -a "$LOG"
	tmux -L "$SOCK" kill-server || true
	exit 1
fi
echo "pass: panes published a control socket" | tee -a "$LOG"
tmux -L "$SOCK" kill-server || true

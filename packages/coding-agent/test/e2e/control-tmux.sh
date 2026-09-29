#!/usr/bin/env bash
# Real-pane control-socket check. Skips unless dist/npi (or NPI) and tmux exist.
# Uses a private tmux socket so it never touches the Captain's panes.
set -euo pipefail
NPI=${NPI:-$(cd "$(dirname "$0")/../.." && pwd)/dist/npi}
if [[ ! -x $NPI ]] || ! command -v tmux >/dev/null; then
	echo "skip: need an executable NPI and tmux"
	exit 0
fi
SOCK=ctl-e2e
tmux -L "$SOCK" kill-server 2>/dev/null || true
tmux -f /dev/null -L "$SOCK" new-session -d -x 200 -y 50 -s ctl
tmux -L "$SOCK" split-window -h
tmux -L "$SOCK" send-keys -t ctl:0.0 "$NPI" Enter
tmux -L "$SOCK" send-keys -t ctl:0.1 "$NPI" Enter
ready=0
for _ in $(seq 1 50); do
	if "$NPI" ctl list --json 2>/dev/null | grep -q instanceId; then
		ready=1
		break
	fi
	sleep 0.2
done
if [[ $ready -ne 1 ]]; then
	echo "fail: sessions did not publish"
	tmux -L "$SOCK" kill-server || true
	exit 1
fi
"$NPI" ctl list
echo "pass: two panes published a control socket"
tmux -L "$SOCK" kill-server || true

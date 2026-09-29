#!/usr/bin/env bash
# Parity sweep (#171) against one live pane on a private tmux socket and a
# private control registry (PI_CONTROL_DIR), so no other npi session on this
# machine is ever listed or targeted. The pane's model is a local fake and is
# checked before any prompt is sent. Gates are printed as passed/total by
# control-parity.ts; any shortfall exits non-zero.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
NPI=${NPI:-$ROOT/dist/npi}
LOG=${LOG:-/tmp/control-parity.log}
if [[ ! -x $NPI ]] || ! command -v tmux >/dev/null || ! command -v bun >/dev/null; then
	echo "skip: need NPI, tmux, and bun" | tee "$LOG"
	exit 0
fi
# shellcheck source=fake-model.sh
source "$HERE/fake-model.sh"
DIR=$(mktemp -d)
mkdir -p "$DIR/ctl" "$DIR/work"
export PI_CONTROL_DIR=$DIR/ctl PI_CODING_AGENT_DIR=$DIR PARITY_DIR=$DIR
SOCK=ctl-parity
start_fake_model "$DIR"
trap 'kill $FAKE_PID 2>/dev/null || true; tmux -L $SOCK kill-server 2>/dev/null || true' EXIT
tmux -L "$SOCK" kill-server 2>/dev/null || true
tmux -f /dev/null -L "$SOCK" new-session -d -x 200 -y 50 -s ctl -c "$DIR/work"
tmux -L "$SOCK" send-keys -t ctl:0.0 "env PI_CONTROL_DIR=$PI_CONTROL_DIR PI_CODING_AGENT_DIR=$DIR $NPI --model fake/echo" Enter
target=""
for _ in $(seq 1 120); do
	target=$("$NPI" ctl list --json 2>/dev/null | bun -e 'const s = JSON.parse(await Bun.stdin.text()).sessions ?? []; const r = s.find(x => x.snapshot?.ready); if (r) console.log(r.meta.instanceId)' || true)
	[[ -n $target ]] && break
	sleep 0.25
done
: >"$LOG"
if [[ -z $target ]]; then
	echo "FAIL no ready pane in the private registry" | tee -a "$LOG"
	tmux -L "$SOCK" capture-pane -p -t ctl:0.0 >>"$LOG" || true
	exit 1
fi
"$NPI" ctl "$target" rpc get_state '{}' >"$LOG.pre" || true
require_fake_provider "$LOG.pre"
{
	echo "binary $NPI"
	echo "sha256 $(sha256sum "$NPI" | cut -d' ' -f1)"
	echo "instance $target"
	"$NPI" ctl "$target" state --json | grep -E "\"gitSha\"" | head -1 || true
} >>"$LOG"
status=0
(cd "$ROOT" && bun "$HERE/control-parity.ts" "$NPI" "$target" "$LOG") || status=$?
echo "=== pane ===" >>"$LOG"
tmux -L "$SOCK" capture-pane -p -t ctl:0.0 >>"$LOG" || true
echo "status=$status" | tee -a "$LOG"
exit "$status"

#!/usr/bin/env bash
# Drive every RPC command and every keybinding id against one live pane.
# Records the response code for each. A missing route (Unknown command) fails.
# Private tmux socket only.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NPI=${NPI:-$ROOT/dist/npi}
LOG=${LOG:-/tmp/control-parity.log}
if [[ ! -x $NPI ]] || ! command -v tmux >/dev/null; then
	echo "skip: need NPI and tmux" | tee "$LOG"
	exit 0
fi
SOCK=ctl-parity
tmux -L "$SOCK" kill-server 2>/dev/null || true
tmux -f /dev/null -L "$SOCK" new-session -d -x 200 -y 50 -s ctl
tmux -L "$SOCK" send-keys -t ctl:0.0 "$NPI" Enter
for _ in $(seq 1 80); do
	if "$NPI" ctl list --json 2>/dev/null | grep -q instanceId; then break; fi
	sleep 0.25
done
: >"$LOG"
fail=0
rpc() {
	local type=$1 params=$2
	local out
	out=$("$NPI" ctl %0 rpc "$type" "$params" 2>/dev/null || true)
	echo "$type $out" >>"$LOG"
	if echo "$out" | grep -q 'Unknown command'; then
		echo "FAIL route $type" | tee -a "$LOG"
		fail=1
	fi
}
# Read-only commands must succeed.
for type in get_state get_available_commands get_entries get_tree get_available_models get_roles get_available_thinking_levels get_session_stats get_usage get_messages get_messages_page get_last_assistant_text get_login_providers get_subagents; do
	rpc "$type" '{}'
done
ok=$(grep -c '"success": true' "$LOG" || true)
echo "readonly_success=$ok" | tee -a "$LOG"
if [[ ${ok:-0} -lt 14 ]]; then
	echo "FAIL expected at least 14 read-only successes, got $ok" | tee -a "$LOG"
	fail=1
fi
# Documented rejections and safe mutators. Success or a stable code both count; an unknown route does not.
rpc negotiate_protocol '{"protocolVersion":1}'
rpc abort '{}'
rpc new_session '{}'
rpc open_session '{}'
rpc set_fast_mode '{"enabled":false}'
rpc set_chat_mode '{"mode":"off"}'
rpc set_mode '{"mode":"agent"}'
rpc set_todos '{"phases":[]}'
rpc set_host_tools '{"tools":[]}'
rpc set_host_uri_schemes '{"schemes":[]}'
rpc set_subagent_subscription '{"level":"off"}'
rpc set_event_filter '{"events":[]}'
rpc set_approval_handler '{"enabled":false}'
rpc get_subagent_messages '{}'
rpc set_model '{}'
rpc cycle_model '{}'
rpc set_role '{}'
rpc set_thinking_level '{}'
rpc cycle_thinking_level '{}'
rpc set_steering_mode '{"mode":"one-at-a-time"}'
rpc set_follow_up_mode '{"mode":"one-at-a-time"}'
rpc set_interrupt_mode '{"mode":"immediate"}'
rpc set_auto_compaction '{"enabled":true}'
rpc set_auto_retry '{"enabled":true}'
rpc abort_retry '{}'
rpc abort_bash '{}'
rpc export_html '{}'
rpc switch_session '{}'
rpc branch '{}'
rpc get_branch_messages '{}'
rpc set_session_name '{"name":"parity"}'
# Actions: every id must be handled, exempt, or a stable unknown_action, never an unrouted command.
actions=$("$NPI" ctl %0 rpc keybindings_get '{}' 2>/dev/null || true)
if echo "$actions" | grep -Eq '"success": true|"success":true'; then
	echo "$actions" | bun -e '
		const raw = await Bun.stdin.text();
		const start = raw.indexOf("{");
		const body = JSON.parse(raw.slice(start));
		const ids = Object.keys(body.data?.bindings ?? body.data ?? {});
		for (const id of ids) console.log(id);
	' | while read -r id; do
		out=$("$NPI" ctl %0 action "$id" --json 2>/dev/null || "$NPI" ctl %0 rpc action "{\"actionId\":\"$id\"}" 2>/dev/null || true)
		echo "action $id $out" >>"$LOG"
		if echo "$out" | grep -q 'Unknown command'; then
			echo "FAIL action route $id" | tee -a "$LOG"
			echo 1 >"$LOG.fail"
		fi
	done
fi
if [[ -f $LOG.fail ]]; then fail=1; fi
echo "=== pane ===" >>"$LOG"
tmux -L "$SOCK" capture-pane -p -t ctl:0.0 >>"$LOG" || true
tmux -L "$SOCK" kill-server || true
echo "fail=$fail" | tee -a "$LOG"
exit "$fail"

# Telegram bridge

The standalone supervised Bun bridge connects a separate Telegram bot to the always-on npi-deck inbox and its persistent NeoPi sessions. Hermes remains independent. See the [source-based Hermes parity matrix](telegram-parity.md) for implemented capabilities and justified exclusions.

## Setup in Settings → Integrations

1. Create a separate bot with BotFather. Do not share its token with Hermes or another long-poll receiver. The bridge never clears another receiver's webhook or changes Hermes configuration.
2. Save the bot token in the Telegram panel, then use **Verify token** to read its identity without sending a message. The saved token never appears in the setup response. Values supplied by the server's launching environment are read-only here.
3. Start the bridge, then create a pairing invitation. Open the invitation in Telegram and press Start, or send the displayed `/start pair_<code>` command in a private chat. Invitations grant this deck's capabilities, expire in ten minutes, are single-use, and are stored as SHA-256 hashes. Creating another invitation or cancelling invalidates the previous one. Unpair removes that grant immediately; a separately configured manual allowlist entry still grants access until removed and the bridge restarted.
4. Manual allowlisting remains available under **Manual allowlist and group access**. Allowed users are comma-separated numeric sender IDs, not usernames. An empty list permits pairing but no ordinary messages until an account is paired. Groups need both an allowed group ID and an allowed or paired sender. Blank group access disables groups. Unauthorized traffic is silently ignored before downloads, session access or inbox capture.
5. **Require group mention** defaults to true. Commands, `@botname` mentions and replies to this bot invoke it. Advanced settings retain **Wake patterns**, `TELEGRAM_MENTION_PATTERNS`, as case-insensitive JavaScript regex triggers in text/captions. Enter a JSON string array or one expression per line; invalid expressions refuse startup. **Free-response chats**, `TELEGRAM_FREE_RESPONSE_CHATS`, takes negative chat IDs. **Free-response topics**, `TELEGRAM_FREE_RESPONSE_TOPICS`, takes `-100123:42` pairs. These bypass mention gating only in their configured lanes. Disabling require-mention accepts every authorized message in allowed, non-excluded group topics. No invocation option bypasses sender and group authorization.
6. Saving does not start anything. Restart the bridge after changing connection or manual allowlist settings. Pairing, chat destinations, default actions and notification preferences apply without restarting NeoPi or the bridge.

Long polling requires outbound HTTPS, not a public inbound port. The panel distinguishes process status from successful polling, shows the bot identity and reports polling errors. Telegram failures remain isolated in the bridge process. Commands are registered in the bot menu.

Bot mentions are admission signals, not content edits. Accepted task text and captions retain bot usernames, including quoted identifiers and values inside card front matter.

**Allowed topics** (`TELEGRAM_ALLOWED_TOPICS`) and **Ignored topics** (`TELEGRAM_IGNORED_THREADS`) accept comma-separated positive topic IDs or scoped `negative-chat-ID:topic-ID` pairs. A bare ID applies across allowed groups. Nonempty allowed-topics restricts groups to those topics; ignored-topics always wins for routable topics, even over commands, wake patterns and free response. Forum General is `1`. Allowed-topics also treats an absent thread in a plain group as `1`, but ignored-topics does not filter plain groups' absent/reply-anchor threads. These filters do not apply to DMs. No invocation option bypasses sender AND group authorization. Non-invoking conversation is dropped, not stored as context.

## Chat destinations and needs-you notifications

Every accepted private chat or group topic appears in **Chat destinations**. Select an existing NeoPi thread to talk to its agent, or detach it to create a fresh thread on the next chat. Choosing a retained thread stores its binding without starting or restarting an agent. Each lane can interpret ordinary messages as task cards, inbox captures or chat prompts. Explicit `/task`, `/capture` and `/chat` override that setting. Accepted durable intake keeps its original mode across restart, even if preferences change later.

Enable **Needs you** for a bound thread to receive plan-review and extension-question notifications in that Telegram lane. A read-only WebSocket observer subscribes to opted-in sessions without resuming stopped sessions. Notifications respect sender, group and topic access, retain topic routing and record successful delivery IDs to suppress replay duplicates for seven days. Failed sends appear on the conversation row. No delivery is claimed before Telegram accepts it. A network interruption after Telegram accepted a send can still leave delivery uncertain.

Telegram does not approve or reject plans on your behalf. A new proposal reports that review is needed in the web UI; the native plan-review lifecycle still applies. Individual child-agent targeting and spawning templates are not fabricated as new root sessions.

### Live management API

- `GET /api/telegram` returns masked configuration, supervisor and poll status, paired users, and conversations.
- `PUT /api/telegram/config` accepts `botToken?`, `allowedUsers?`, `allowedGroups?` and `requireMention?`. Launch-environment values cannot be overridden.
- `POST /api/telegram/verify` calls Telegram `getMe`, not `sendMessage`.
- `POST /api/telegram/pairing` creates `{code, expiresAt, url?}`; `DELETE` cancels it.
- `DELETE /api/telegram/users/:id` revokes a paired user's grant.
- `PATCH /api/telegram/conversations/:id` accepts `mode?: "task" | "capture" | "chat"`, `sessionId?: string | null`, and `notify?: boolean`.

These use the deck's existing local API trust boundary. Pairing is not a guest sandbox or a separate multi-user permission system.

## Inbox and kanban

DM text and invoked group text initially default to tasks. The per-chat preference can instead select capture or chat. Task mode creates `ticket` inbox items, then promotes through the existing inbox API to kanban cards. This does not execute an agent or run a card. Plain prose produces one card. An explicit list with two or more top-level bullets, checklist items or numbered entries produces one card per item, retaining introductory context and continuation lines.

Every resulting card retains native TOML front matter between `+++` lines:

```text
/task
+++
read-only = true
worktree = "/path/to/existing-worktree"
model = "provider/model"
role = "research"
priority = "high"
cwd = "/path/to/project"
[custom-property]
owner = "Captain"
+++
Investigate the routing:
1. Trace inbox receipt
2. Identify session ownership
```

`read-only` must be a boolean. `worktree`, `model`, `role`, `cwd` and `stateId`, when supplied, must be nonempty strings. Unknown TOML keys, nested tables and arrays are retained. The same merged card front matter begins **each** decomposed card body; the shared TOML patcher preserves comments while applying defaults and removing routing fields. The inbox provenance footer is appended after it. `cwd` and `stateId` are routing fields, removed from that property block: `cwd` separately sets the task's project assignment via `PromoteInboxItemRequest.cwd`, while `stateId` selects an existing kanban column. Neither is inferred from `worktree` or the deck default directory. Without explicit `cwd`, promotion leaves the task's project unassigned. No worktree is created or deleted by this bridge.

`/properties <TOML>` persists defaults for this chat/topic; task front matter overrides defaults. `/properties` displays native TOML and `/properties clear` clears them. For example, `/properties read-only = true` sets the boolean default. Defaults survive bridge restarts and never bleed into another topic. New Telegram tasks and `/properties` do not accept YAML; legacy card bodies are imported only at the server's persistent migration seam, retaining exact originals. `/capture <text>` saves an unprocessed capture only: it does not auto-file captures, ideas, decisions, investigations or email. `/inbox` lists the deck's unprocessed items.

If a multi-card task fails midway, already filed cards and received inbox items remain visible; inspect the inbox/board before resending. Filing is per card, not an all-or-nothing batch. A Telegram reply failure cannot undo a stored card.

## Commands and persistent sessions

All commands work in DMs and allowed groups, with optional `/command@botname` suffixes.

| Command | Behavior |
| --- | --- |
| `/start`, `/help`, `/commands` | Explain intake and list commands. |
| `/task <text>` | Explicit inbox→kanban intake (same as ordinary DM task text). |
| `/capture <text>`, `/inbox` | Save unprocessed capture; list unprocessed inbox items. |
| `/properties [TOML or clear]` | Set/display/clear conversation-scoped card defaults. |
| `/chat <text>` | Explicitly prompt the bound NeoPi session. Native NeoPi commands can be sent as `/chat /command`. |
| `/session`, `/status` | Show current binding, title and workspace. |
| `/sessions [search <query>]` | List numbered retained sessions with titles. Search case-insensitively matches title/ID substrings, scoped to this conversation, without reading transcripts or starting sessions. `/sessions <ID\|title\|number>` also selects a session. |
| `/bind <deck session ID>` | Bind an existing deck session (ID from deck session picker/API). Reuse its live handle or resume its persisted transcript. |
| `/resume <ID\|title\|number>` | Resume a retained session by exact ID, exact case-insensitive title or 1-based number. Numbers refer to this lane's latest displayed list (including search results); after bridge restart, refresh `/sessions`. Duplicate titles require an ID/number. Other conversations' history is not exposed. |
| `/new`, `/reset` | Detach current binding without destroying a live NeoPi or its transcript. Next `/chat` starts fresh; old sessions remain resumable. |
| `/stop` | Abort the bound turn immediately, bypassing its per-conversation queue. |
| `/title [name]` | Show current title without creating/resuming a session, or rename the bound session. |
| `/model [provider/model]` | List/select session model via the deck API, not Hermes configuration. |
| `/compact [focus]` | Compact bound session via the deck API. |

Session bindings/history and card defaults live in `TELEGRAM_BRIDGE_DB_PATH` (default: the deck data directory's `telegram-bridge.db`). Existing chat-only DM mappings are preserved. Group/forum topics and DM topics have separate lanes; forum General consistently uses topic 1. Native direct-message topics are distinguished from message-thread topics. Every outbound chunk stays in its originating topic, including command replies.

`/chat` lazily creates a session if unbound. An inactive binding resumes its exact stored transcript through the deck; an active persistent NeoPi is reused. Resume failure is reported, never silently replaced by an empty session. `/new` is the explicit fresh-start choice. No command restarts NeoPi. Only deck-supported native commands are forwarded. An already pending plan review blocks a Telegram prompt until resolved in the web UI; new proposals remain under NeoPi's review lifecycle rather than being automatically rejected.

## Photos and unsupported media

Caption a photo with `/chat` and optional text. The largest size is downloaded and sent as an image attachment to NeoPi. A task caption instead files text cards and says the photo was not attached. Location/venue pins can become text tasks. Documents, audio/voice, video/video notes, animations, stickers and other unsupported attachments receive an explicit warning **before** an authorized task/chat/capture caption is forwarded as text only. Uncaptioned unsupported attachments do not create cards or NeoPi turns; unauthorized or non-invoking messages cause no warning, download or typing action.

Audio transcription, video/document extraction, TTS and outbound files are excluded Hermes provider/tool pipelines. Sticker/animation rendering is also excluded: these require their own download/format conversion and media-intake lifecycle, not just the existing Telegram photo path. An image-capable protocol alone does not make sticker vision impossible; this bridge does not implement that additional pipeline or imply it processed the content.

Explicit `/chat` sends a topic-routed typing indicator and refreshes it while downloads/session work run, stopping on success, failure or cancellation. Text replies stream through throttled edits (`TELEGRAM_EDIT_INTERVAL_MS`, default 700, 250–5000 allowed), with safe long-message chunking. `TELEGRAM_POLL_TIMEOUT_SECONDS` defaults to 30 (1–50 allowed); transport requests are bounded. Diagnostics remove the configured token and transport exceptions never expose credential-bearing URLs.

For offline verification, `TELEGRAM_API_ORIGIN` can point to a local fake Bot API. It accepts HTTPS or loopback HTTP and defaults to `https://api.telegram.org`. `apps/bridges/telegram/src/integration.test.ts` exercises setup, pairing, revocation, session binding, streamed edits, long replies, capture and attention notifications against local HTTP/WebSocket fixtures. No real Telegram account is used.

## Troubleshooting

- **No reply:** check Settings bridge status, numeric sender/group allowlists, correct bot suffix and mention policy. Unauthorized traffic deliberately has no outward response.
- **Polling conflict/webhook:** use a distinct bot token; stop/configure the conflicting receiver yourself. The bridge never modifies another receiver to take ownership.
- **Resume fails:** preserve the database and transcript; inspect deck session status. Use `/bind` to choose a known session or `/new` deliberately. Never delete a mapping database merely to hide a failed resume.
- **Credentials unavailable:** edit the masked Settings fields. Do not print the managed `.env` or bot token.
- **Slow replies:** inspect bridge/deck status and edit interval. The bridge supervises neither the live Hermes receiver nor a separate NeoPi installation.

# irc

Send direct messages or address a named group. Groups are address lists on the local IRC host, not shared transcripts; each delivery follows the existing IRC path into the recipient's own session. There is no cross-daemon group enrollment or delivery.

`irc` is a built-in tool. Default toolsets expose it to subagents and to top-level agents that can spawn peers. Grant `irc` in an agent's tool list (or SDK `toolNames`) to let it coordinate without `write`. An explicit IRC disable still takes precedence. Existing `write agent://<id>` direct messaging is unchanged.

Live advisors can be granted `irc` without `write`. They can join and speak in named groups under their own registry IDs (for example, `Main/advisor:architect`). Their read-only transcripts still receive no IRC messages, including member notices and group deliveries. They are not added to `everyone` by default.

## Tool operations

| `op` | Fields | Effect |
| --- | --- | --- |
| `send` | `to: string \| string[]`, `message: string`, optional `replyTo: string`, `progress: boolean` | DM one or more exact peer IDs; direct delivery never waits for a reply. |
| `send` | `group: string`, `message: string` | Send to the group's members that accept incoming IRC, including the sender if eligible. |
| `broadcast` | `message: string` | Send to `everyone`; `send` with `group: "everyone"` or `to: "all"` is equivalent. |
| `create` | `group: string`, `members: string[]` | Create a group with at least one registered peer; include your own ID to join. |
| `add` | `group: string`, `members: string[]` | Add one or more peers; new members receive a notice. |
| `remove` | `group: string`, `members: string[]` | Remove the specified members. |
| `leave` | `group: string` | Remove yourself. |
| `groups` | — | List all group names and sizes. |
| `members` | `group: string` | List the peer IDs in the group. |
| `my_groups` | — | List the groups you belong to. |
| `keep` | `group: string`, `reason: string` | As the sole member, extend the deletion deadline by five minutes. |

Group names are case-sensitive and use letters, digits, hyphens, or underscores; the first character must be alphanumeric. Spawn agents first, then add their IDs. `irc` returns a text summary and per-recipient delivery receipts for sends. Group deliveries name the sender and group and do not open tracked reply waits.

The primary, operator, and spawned agents join fixed `everyone` by default. Explicitly removing a member opts that peer out of broadcasts (including `write agent://all`) without affecting DMs or other groups. `everyone` remains even when empty. Other groups disappear when the last member leaves or is removed; idle and parked members stay, while killed or unregistered peers are removed. When a group has just one member, that member is reminded that the group expires in ten minutes unless kept or joined by another peer. If another member joins, expiry is canceled.

When session persistence is enabled, the owning session saves named groups, `everyone` opt-outs, and expiry deadlines, including extensions from `keep`. Restarting or resuming the session restores them. Parked agents can still be members; peers that are gone or killed are removed. Time offline counts toward an expiry deadline. A fork takes the group state at its fork point, and later membership edits are independent.

## Operator `/irc`

`/irc` alone opens the existing IRC viewer. Send as the operator with `/irc Scout <message>` (or `/irc Scout,Reviewer <message>` for several DMs), `/irc #council <message>`, or `/irc all <message>`. The viewer's reply action still sends a DM.

- `/irc group create council Scout Reviewer`
- `/irc group list` or `/irc group mine`
- `/irc group members council`
- `/irc group add council Editor Operator`
- `/irc group remove council Editor`
- `/irc group keep council Waiting for another reviewer`
- `/irc group leave council`

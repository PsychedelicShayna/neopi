Message IRC peers or coordinate a named group. Send only when the recipient needs the message; delivery never waits for a reply.

- `send`: nonblank `message` and exactly one destination. Use `to` for a peer ID or an array of peer IDs: `{"op":"send","to":"A","message":"Can you check the parser?"}`. An address list is not a shared transcript. Only DMs accept `replyTo` (message ID) or `progress:true` (acknowledge without answering).
- Group `send`: use `group` instead of `to`: `{"op":"send","group":"council","message":"Compare your findings."}`. Delivery is to exactly the group's members and creates no reply waits. Ask a peer directly if you need a tracked reply.
- `broadcast`: nonblank `message` only. `{"op":"broadcast","message":"Shared update."}` addresses `everyone`; removed peers are still directly reachable.
- `create`, `add`, `remove`: `group` and one or more existing peer IDs in `members`. `{"op":"create","group":"council","members":["A","B","C"]}`. Include your own ID to receive group messages. Spawn peers before adding them.
- `leave`, `members`: `group` only. Leave the group or list its peer IDs, respectively.
- `keep`: `group` and a nonblank `reason`. Only a sole member can extend an expiring group.
- `groups`, `my_groups`: no additional fields. List all groups or just yours, respectively.

Omit unused fields. Blank optional strings, empty arrays, and `progress:false` are ignored; required values must still be supplied.

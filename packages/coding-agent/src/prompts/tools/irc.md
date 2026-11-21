Message IRC peers or coordinate a named group. Send only when the recipient needs the message; delivery never waits for a reply.

- Direct: `{"op":"send","to":"A","message":"Can you check the parser?"}`. Use an array of IDs for multiple DMs. `replyTo` threads a direct reply; `progress:true` acknowledges without answering.
- Create with one or more existing peer IDs: `{"op":"create","group":"council","members":["A","B","C"]}`. Include your own ID if you should receive group messages. Spawn first, then add.
- Send to exactly the group's members: `{"op":"send","group":"council","message":"Compare your findings."}`. `{"op":"broadcast","message":"Shared update."}` addresses `everyone`; removed peers are still directly reachable.
- `groups` lists all groups; `my_groups` lists yours; `members` takes `group` and lists its IDs.
- `add` and `remove` take `group` and `members` (an array of IDs). `leave` takes `group` and removes you. `keep` takes `group` and a nonempty `reason`; only a sole member can extend an expiring group.

An address list is not a shared transcript. Use `to` for a peer and `group` for a list; NEVER supply both. Group sends do not create reply waits; ask a peer directly if you need a tracked reply.

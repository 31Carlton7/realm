# Realm Mobile wire protocol, version 1

Plan 28's contract between three implementations:
- the Mac's gateway (`apps/server/src/remote`, TypeScript);
- the relay (`services/relay`, a Cloudflare Worker);
- the iPhone (`apps/ios/RealmKit`, Swift).

Any change here changes all three. The tests that hold them to it are named at the end.

Notation:
- `b64u(x)` is base64url without padding.
- `utf8(s)` is the UTF-8 bytes of `s`.
- `||` is concatenation.
- All JSON is UTF-8 with no BOM.

## 1. Identities

Every Mac and every phone holds two long-lived key pairs, as raw 32-byte keys:

| Name | Algorithm | Used for |
|---|---|---|
| `dh` | X25519 | Noise: end-to-end encryption and authentication |
| `sign` | Ed25519 | Proving to the relay which device is connecting, and nothing else |

A device's id is derived from its `sign` public key:

```
id(signPub) = b64u(SHA-256(signPub)[0..16])        // 22 characters
```

`macId` is the Mac's id and `phoneId` is a phone's id. The relay can check an id against the key
that claims it, so ids need no registration.

## 2. Pairing link

The Mac shows this link as a QR code. Development builds also accept the scheme
`realm-mobile://pair#1.<data>`.

```
https://realm.computer/pair#1.<b64u(JSON)>
```

JSON fields:

| Field | Meaning |
|---|---|
| `r` | the relay's base URL, `wss://…` with no trailing slash |
| `m` | `macId` |
| `k` | `b64u` of the Mac's `dh` public key |
| `s` | `b64u` of a 32-byte random pairing secret, the Noise PSK |
| `w` | the pairing window's id: 16 random bytes, `b64u` |
| `n` | the Mac's display name |
| `e` | the window's expiry, in Unix milliseconds |

The data sits after `#`, so a browser that opens the link never sends it to a server. The leading
`1.` is the link's version. A phone refuses a version it does not know, and refuses an expired
link.

## 3. The relay connection

There are three WebSocket URLs, all under the relay base `r`:

| Role | URL |
|---|---|
| Mac | `/v1/mac/<macId>` |
| phone | `/v1/phone/<macId>/<phoneId>` |
| pairing phone | `/v1/pair/<macId>/<windowId>` |

Every connection follows the same rules:
- **Text messages** are control messages: JSON objects with a `t` field.
- **Binary messages** are data.
- **No compression:** clients must not offer `permessage-deflate`. Every binary message is
  ciphertext, which does not compress, and compressing it costs CPU and latency on both ends.
  Cloudflare accepts the extension when offered, and Node's `ws` offers it by default.
- **Heartbeat:** a client may send the text `ping` at any time. The relay answers `pong` without
  running any code (`setWebSocketAutoResponse`). Macs and phones send it every 20 s while
  connected.

### 3.1 Authentication (Mac and phone roles)

1. **The relay challenges.** As soon as the socket opens, the relay sends:

   ```
   {"t":"challenge","nonce":"<b64u 32 random bytes>"}
   ```

2. **The client signs** with its `sign` key and replies:

   ```
   {"t":"auth","key":"<b64u signPub>","sig":"<b64u signature>"}
   ```

   The signature covers:

   ```
   utf8("realm-relay/1\n" + role + "\n" + macId + "\n" + phoneIdOrEmpty + "\n" + nonce)
   ```

   Here `role` is `mac` or `phone`, and `nonce` is the challenge string exactly as sent.
3. **The relay checks:**
   - the signature;
   - that `id(key)` equals the id in the URL (`macId` for a Mac, `phoneId` for a phone);
   - for a phone, that the Mac's current phone list contains that `phoneId` with that same key.
4. **The relay replies `ready`.** For a Mac:

   ```
   {"t":"ready"}
   ```

   For a phone:

   ```
   {"t":"ready","mac":{"online":<bool>,"lastSeen":<ms|null>}}
   ```

A client may pipeline: once it has sent `auth`, it may send data without waiting for `ready`. The
relay handles one socket's messages in order.

A **pairing phone** sends no `auth`. The relay accepts it only while the Mac has a pairing window
open with that `windowId` and attempts remaining. It then sends
`{"t":"ready","mac":{"online":<bool>,"lastSeen":<ms|null>}}` straight away. Each accepted socket
uses one of the window's attempts.

Close codes:

| Code | Meaning |
|---|---|
| 4400 | malformed message |
| 4401 | authentication failed |
| 4403 | not allowed: unknown phone, no open window, or attempts used up |
| 4408 | no `auth` within 10 s |
| 4409 | replaced by a newer connection for the same device |
| 4410 | removed by the Mac |
| 4413 | frame too large (over 1 MiB) |

### 3.2 Channels

- **The relay names channels.** Each phone socket (paired or pairing) is one channel. The relay
  gives it a 16-byte channel id, `ch`.
- **The Mac's socket carries every channel.** Each binary message on it is `ch (16 bytes) || bytes`.
- **A phone's socket carries only its own channel.** Its binary messages are just `bytes`, with no
  prefix.
- **The relay forwards and never looks past the prefix.** Binary from a phone goes to the Mac as
  `ch || bytes`. Binary from the Mac goes to channel `ch` as `bytes`.
- **If the Mac is not connected,** binary from a phone is dropped, and the phone is sent
  `{"t":"mac","online":false,"lastSeen":<ms|null>}`.

Control messages from the relay to the Mac:

```
{"t":"open","ch":"<b64u>","phone":"<phoneId>"}            a paired phone connected
{"t":"open","ch":"<b64u>","pair":"<windowId>"}            a pairing phone connected
{"t":"close","ch":"<b64u>"}                                that phone's socket closed
{"t":"pushed","phone":"<phoneId>","id":"<id>","ok":<bool>,"status":<int>,"reason":"<string|null>"}
```

When a Mac becomes connected (its socket is authenticated):
- it is sent one `open` for every phone socket already connected;
- every phone is sent `{"t":"mac","online":true,"lastSeen":<ms>}`.

When the Mac's socket closes, every phone is sent `{"t":"mac","online":false,"lastSeen":<ms>}`.

**A quiet Mac is announced too.** A sleeping Mac, or one whose network was pulled, sends no close; its
socket just stops. While any phone is connected:
- once the Mac's last message or heartbeat is more than 60 s old, every phone is sent
  `{"t":"mac","online":false,"lastSeen":<ms>}`, once;
- the Mac's next message of any kind sends every phone `{"t":"mac","online":true,"lastSeen":<ms>}`.
  A message does that at once. A heartbeat does it within 10 s, because the relay's runtime answers
  heartbeats without waking the relay.

A phone that connects while the Mac is quiet learns that from its `ready`, and is not sent the notice
again.

Phase 1 measured the gap this closes: a frozen Mac was never reported, not within 180 s.

Control messages from the Mac to the relay:

```
{"t":"phones","list":[{"id":"<phoneId>","key":"<b64u signPub>"}, …]}
{"t":"pair","window":"<windowId>","until":<ms>}      open a pairing window: 5 attempts, ≤ 10 minutes
{"t":"pair","window":null}                           close it
{"t":"close","ch":"<b64u>"}                          close that channel's socket (code 4000)
{"t":"push","id":"<id>","phone":"<phoneId>","blob":"<b64u>","urgent":<bool>,"collapse":"<string|null>","badge":<int|null>}
```

- **`phones`** replaces the whole allowed list. The Mac sends it after every `ready`. Any connected
  phone missing from the new list is closed with 4410.
- **The pairing window** is closed by the relay itself when the Mac's socket closes.

Control messages from a phone to the relay:

```
{"t":"apns","token":"<hex device token>","env":"sandbox"|"production"}
```

**Liveness.** The relay treats the Mac as online when two things hold:
- its socket is authenticated;
- its last message or heartbeat came less than 60 s ago.

`lastSeen` is the time of that last message or heartbeat.

### 3.3 Moving to another relay

A pairing names a relay (§2), but the Mac's relay can change: a released build dials Realm's production
relay where a development build dials staging, and a relay can move to a new address. Phones follow
their Mac, so a move pairs nobody again.

The Mac:
- **keeps one relay as its own.** Pairing windows open there, and its links carry the QR code's `r`.
- **remembers where each phone is:** the relay it paired at, then the relay it was last seen on.
- **dials every relay a phone is still on,** as well as its own, with the same `auth`. Each relay is
  sent the whole `phones` list, so a phone that follows is let in where it arrives.
- **names its own relay in IK message 2** (§4.2), but only while its own relay has answered its `auth`.
  A phone is never sent to a relay that is not working.
- **closes the channel of a phone it could not name its relay to,** once its relay answers, so the phone
  connects again and hears it.
- **sends a push through the relay the phone was last seen on.** That relay holds its push token.
- **lets go of a relay no phone is on any more.** It sends that relay `{"t":"phones","list":[]}`, which
  takes every key and push token off it, and closes its socket.

A phone that hears a relay in IK message 2 other than the one it dialled:
- keeps the new relay in its pairing;
- connects there instead, sending its push token again on `ready`.

A phone from before §3.3 ignores the field and stays on the relay it paired at. The Mac stays there for
it until it is removed, and never closes its channel to tell it again.

## 4. Noise

All three protocols are from the Noise Protocol Framework, revision 34:

| Protocol | Pattern | Initiator | Used for |
|---|---|---|---|
| `Noise_IKpsk1_25519_AESGCM_SHA256` | `<- s` / `-> e, es, s, ss, psk` / `<- e, ee, se` | phone | pairing |
| `Noise_IK_25519_AESGCM_SHA256` | `<- s` / `-> e, es, s, ss` / `<- e, ee, se` | phone | every connection after pairing |
| `Noise_K_25519_AESGCM_SHA256` | `-> s`, `<- s` / `-> e, es, ss` | sender | sealed one-way messages: pushes |

AES-GCM's nonce is four zero bytes, then `n` as a big-endian 64-bit integer.

Prologues use `0x00` as the separator byte:

```
pair:  utf8("realm-pair/1")   || 0x00 || utf8(macId) || 0x00 || utf8(windowId)
ik:    utf8("realm-mobile/1") || 0x00 || utf8(macId) || 0x00 || utf8(phoneId)
push:  utf8("realm-push/1")   || 0x00 || utf8(macId) || 0x00 || utf8(phoneId)
```

### 4.1 Pairing (IKpsk1, on a pairing channel)

1. **Phone → Mac, message 1.** The phone's static key is its `dh` key, and the PSK is the link's
   `s`. The payload is:

   ```
   {"v":1,"name":"<device name>","model":"<model identifier>","sign":"<b64u signPub>"}
   ```

2. **The Mac checks** that the window is open and that message 1 decrypted. A wrong secret cannot
   decrypt it.
3. **Mac → phone, message 2.** The payload is `{"v":1,"mac":"<Mac name>"}`.
4. **The Mac asks its owner.**
   - On yes, it records the phone (`dh` from the handshake; `sign`, name and model from the
     payload). It sends the relay a new `phones` list. Then it sends the transport message
     `{"event":"pair.result","payload":{"ok":true,"phoneId":"<phoneId>"}}`.
   - On no or timeout, it sends `{"event":"pair.result","payload":{"ok":false,"reason":"declined"|"expired"}}`.
5. **The Mac closes the channel.**

The phone then connects as itself (`/v1/phone/…`) and runs IK.

### 4.2 Every connection (IK)

1. **Phone → Mac, message 1.** The payload is
   `{"v":1,"app":"<app version>","os":"<OS version>"}`.
2. **The Mac checks** that the static key revealed in message 1 equals the `dh` key it recorded for
   the channel's `phoneId`. If not, it closes the channel.
3. **Mac → phone, message 2.** The payload is
   `{"v":1,"mac":"<Mac name>","server":"<Realm version>","relay":"<relay base>"}`. `relay` is the Mac's
   own relay (§3.3), and is left out while that relay has not answered the Mac. A Mac before §3.3
   sends no `relay`.

After message 2 both sides `Split()`:
- the phone sends with the first cipher and receives with the second;
- the Mac does the opposite.

A phone that receives `{"t":"mac","online":true,…}` after being offline starts a new handshake,
because the Mac's channel state did not survive.

### 4.3 Sealed messages (K)

The sender is the initiator. Both static keys are known in advance. The single handshake message
carries the payload, and nothing follows it.

A push is sealed by the Mac to one phone with the `push` prologue. Its payload is:

```
{"v":1,"id":"<id>","at":<ms>,"kind":"permission"|"question"|"finished"|"failed"|"blocked"|"test",
 "title":"<string>","body":"<string>","session":"<sessionId>"|null}
```

Two fields may follow, and a phone that does not know them ignores them:

```
"category":"permission"|"permission.space"|"permission.site"|"reply",   what the notification answers
"request":"<requestId>"                                                  the request Allow and Deny answer
```

- `permission` offers Allow, Allow always and Deny, the desktop card's answers. `permission.space` names
  Allow always "Always allow in this space" (`computer_act`), and `permission.site` names it "Always allow
  on this site" (a password filled on its own site). Each answers with `session.answer`.
- `reply` takes a message for `session`, sent with `session.send`.
- Absent, the push is filed under its `kind` and answered in the app: a question, a plan, a blocked run,
  a test, or a push from a Mac before this field.

The receiver drops any id it has already seen, and anything whose `at` is more than 24 h old.

## 5. Transport framing

- **One transport message per binary data message.** Each is at most 65,535 bytes of ciphertext,
  the tag included.
- **Each plaintext opens with a flag byte.** `0x00` means this fragment ends the application
  message. `0x01` means more fragments follow. The rest of the plaintext is the fragment, at most
  65,518 bytes.
- **The receiver joins fragments** until one has flag `0x00`, then parses the result as UTF-8 JSON.
- **Handshake messages are unframed.** They are carried as they are, one per binary data message.

## 6. Application messages

The same envelope as the desktop's RPC:

```
request   {"id":<int>,"method":"<name>","params":{…}}
response  {"id":<int>,"ok":true,"result":…} | {"id":<int>,"ok":false,"error":{"code":"<string>","message":"<string>"}}
event     {"event":"<name>","payload":{…}}
```

Phones send requests. The Mac sends responses and events. The calls and events are `mobile.v1`,
defined in `src/mobile-api.ts`.

## 7. Pushes through APNs

For `push`, the relay looks up the phone's APNs token and sends an alert:

```
POST https://api[.sandbox].push.apple.com/3/device/<token>
authorization: bearer <ES256 JWT {iss: TEAM_ID, iat} kid KEY_ID>
apns-topic: co.charmtechnologies.realm.ios
apns-push-type: alert
apns-priority: 10 if urgent, else 5
apns-collapse-id: <collapse>                    only when given
{"aps":{"alert":{"title":"Realm","body":"Something on your Mac needs you"},"mutable-content":1,
        "sound":"default","badge":<badge>,"interruption-level":"time-sensitive"|"active"},
 "m":"<macId>","r":"<blob>"}
```

- `badge` appears only when the push gives one.
- `interruption-level` is `time-sensitive` when the push is urgent, and `active` otherwise.

The Notification Service Extension:
1. finds the pairing for `m`;
2. opens `r` with K;
3. rewrites the notification from the payload.

If any step fails, the placeholder stays. There is never a plaintext fallback.

## 8. mobile.v1

All times are Unix milliseconds. A field marked `?` may be absent. A reader must ignore fields it
does not know, so the Mac can add fields without breaking an older phone. Everything added after
Phase 1 is a field marked `?`, a new call or a new event: an older phone ignores all three, and a
newer phone treats a missing field as the Phase 1 meaning given beside it.

### Rows

A **session row** is one session in a list:

```
SessionRow {
  id, title, spaceId, spaceName, agent,
  model: string|null,
  status: "idle"|"running"|"waiting"|"error"|"ended",
  needsYou: bool,
  unread: bool,
  updatedAt: ms,
  agentName?: string,     the agent as the desktop names it ("Claude", "GitHub Copilot")
  agentMark?: string,     the mark the desktop draws for it: a vendor's ("claude", "openai") or a glyph ("bot")
  modelLabel?: string,    the model as the desktop's chip names it ("Opus 5.5"); with none given, see
                          "A session with no model" below
  createdAt?: ms,         when the session was made
  effort?: string|null,   the reasoning level it was given, or null for the model's own
  permissionMode?: string,
                          how freely the agent acts ("default", "acceptEdits", "bypassPermissions"),
                          or the mode it is in instead ("plan", "ask"), as the desktop stores it
  activityAt?: ms,        when the conversation last moved: a message went out, or the agent answered
                          or finished a turn
  pinned?: bool,          pinned in the desktop's sidebar, so Home lists it in Pinned
  moving?: true           being moved to another checkout (`session.move`); absent otherwise
  goal?: {status, objective}
                          the goal it pursues, by `Goal.status`; absent for none
}
```

- `waiting` is the desktop's `waiting_permission`.
- A session being moved is `running` with `moving: true`: `running` is the word a phone from before
  moves already waits on, and a newer one says Moving.
- `needsYou` is true exactly when the row is in `home.get`'s `needsYou`.
- **Lists are ordered by `activityAt`**, as the desktop's are, and a row's age is read from it.
  `updatedAt` moves whenever the Mac writes the row, for a change of settings or a rename as much as
  for a message, so a session set up again is not one that moved. A Mac before Plan 29 sends no
  `activityAt`; there `updatedAt` stands in.

A **transcript row** is one thing in a session's transcript. Every row has `key`, `seq` and `kind`,
then the fields its kind adds:

| `kind` | Fields |
|---|---|
| `user` | `text`, `attachments?: [{path, name, mime}]`, `tabs?: [TabCard]`, `teammateId?` |
| `assistant` | `text`, `streaming: bool` |
| `thinking` | `text` |
| `tool` | `name`, `summary`, `state: "running"\|"done"\|"error"`, `detail: string\|null`, `teammate?: {id: string\|null, handle, message}` |
| `request` | `requestId`, `tool`, `title`, `summary`, `state: "pending"\|"allowed"\|"denied"`, `questions: [Question] \| null`, `asker?`, `message?`, `answers?`, `plan?: {text: string\|null, steps: [{text, status}] \| null}` |
| `plan` | `text: string\|null`, `steps: [{text, status}] \| null` |
| `notice` | `text`, `checkpointId?`, `files?: [{path, size}]`, `move?: "moving"\|"moved"\|"failed"`, `detail?`, `goal?: "continuation"\|"budget"` |
| `error` | `text`, `hint: string\|null` |
| `unknown` | `type`: the event type this phone cannot draw |

- **A key names a row.** Keys look like `u:<seq>`, `m:<messageId>`, `k:<messageId>`,
  `t:<toolUseId>`, `r:<requestId>`, `p:<planId>`, `c:<checkpointId>`, `mv:<moveId>` or `e:<seq>`.
- **A later row with the same key replaces the earlier one** where it stands. That is how streamed
  text, tool results and answered requests update in place.
- **`seq`** is the server's sequence number of the event that made the row. Streamed rows carry the
  seq of the last persisted event before them.

A **request** is a question when it carries `questions`, a plan to approve when its `tool` is
`ExitPlanMode`, and a permission otherwise. The questions are read from Realm's own ask card, by the
rule the desktop's card uses (`questionOf` in `@realm/view`), never from an agent's arguments alone:

```
Question {
  question: string,          the prompt
  header: string,
  multiSelect: bool,
  options: [{label, description?, value?}],    value?: what the answer carries, where it is not the label
  id?: string,               the key its answer goes under; absent from a Phase 1 Mac, where it was `question`
  kind?: "choice"|"multi"|"text"|"confirm"|"model"|"file"|"branch"|"time"|"link"
  allowOther?: bool,         an answer of the person's own is taken beside the options; absent means yes
  secret?: bool,             typed into a masked field, and kept by the Mac only as a mark
  required?: bool, detail?: string, placeholder?: string, default?: string|[string]
}
```

- A `confirm` question carries the options `Yes` (`yes`) and `No` (`no`), as the desktop draws it.
- `asker` says who asks: the agent's name, or `<name>'s MCP server`. `message` is what they said
  the questions are for.
- `answers`, once the request is answered, are the answers as the Mac logged them: question id → a
  value or a list of values, a secret one only as `••••••`.
- `plan` is on an `ExitPlanMode` request: the plan's text (from the request, else the session's
  latest plan), and the latest plan's steps.

A **notice** may lead somewhere. A turn's changes carry `checkpointId`, which `session.changes`
opens. A turn's files made carry `files`, each of which `session.file` previews.

A **move** is one notice, keyed `mv:<moveId>`. While it goes it carries `move: "moving"` and the step
it has reached, as the desktop's progress row names it ("Moving · Setting up the checkout"); the same
row then says how it ended, in the desktop's words: `moved` ("Moved from realm (main) to
tidy-settings. The conversation continued.", or "…continued from notes."), with both paths in
`detail` ("~/realm → ~/Realm/worktrees/realm/tidy-settings"); or `failed`, the one sentence for the
step it stopped at and where the session still is ("Couldn't move this session while setting up the
checkout. It's still in tidy-settings."), with the Mac's reason, then whatever it left as it was, in
`detail`. Each step is stored, so a session opened mid-move shows its progress row, and one opened
later shows how the move ended. A phone that knows no `move` draws each as the notice it is.

A **goal's own turn** is a notice, never a user row. When a session's goal sends the next turn itself
(`user_message` with `goal`), the row says so in the desktop's words, "Realm continued this goal" or
"Goal budget spent — Realm asked for a handover", with `goal` set and the prompt Realm sent in
`detail`, which the desktop also keeps behind a tap. A phone that knows no `goal` draws the plain
notice, so the prompt never reads as words the person typed. The objective itself is the person's
own message, and stays a user row.

A **user row** carries `attachments` when files were sent with the message: each by its path on the
Mac, its name and its type, as the message's `user_message` recorded them. `session.file` previews
each. `name` is the name the person gave the file: one a phone sent, or a paste, is written into the
Realm home's `tmp/attachments` as `<random>-<name>`, and `name` leaves the prefix off. A file anywhere
else keeps its own name, whatever it looks like.

### Calls

| Method | Params | Result |
|---|---|---|
| `ping` | `{}` | `{at: ms}`, the Mac's clock |
| `home.get` | `{profileId?}` | `{mac: {name}, needsYou: [SessionRow], spaces: [Space], profiles?: [Profile], profileId?: string\|null, recent?: [SessionRow]}` |
| `space.sessions` | `{id, offset?: int = 0, limit?: int = 50}` | `{sessions: [SessionRow], more: bool}`. `limit` is at most 100. |
| `session.open` | `{id, limit?: int = 200, from?: int}` | `{session: SessionRow, rows: [Row], hasMore: bool, hint?: string\|null, queued?: [QueuedMessage], move?: PendingMove\|null, goal?: Goal\|null, todos?: [Todo]}`. `limit` is at most 1,000. `from` is a row's `seq`, a search's match: the rows reach back to it where it is further back than `limit`, up to 1,000 rows in all. An older Mac ignores it. |
| `search.query` | `{query, profileId?}` | `{hits: [{session: SessionRow, title: Snippet\|null, message: {seq, snippet: Snippet}\|null}]}`. See below. |
| `session.close` | `{id}` | `{ok: true}` |
| `session.update` | `{id, title?, pinned?: bool, archived?: bool}` | `{session: SessionRow\|null}`: null once it is archived |
| `session.queue` | `{id}` | `{queued: [QueuedMessage], move?: PendingMove\|null}` |
| `session.sendQueuedNow` | `{id, queuedId}` | `{ok: true}` |
| `session.removeQueued` | `{id, queuedId}` | `{ok: true}` |
| `session.holdQueued` | `{id, queuedId, held: bool}` | `{ok: true}` |
| `session.editQueued` | `{id, queuedId, text}` | `{ok: true}` |
| `session.subagents` | `{id}` | `{subagents: [Subagent]}` |
| `teammates.list` | `{archived?: bool}` | `{teammates: [{id, spaceId, name, handle, brief, lead: bool, chatId: string\|null, icon?: {shape, color}, state?, stateSince?, unread?, activity?, activityAt?, agentKind?, model?, effort?, permissionMode?, group?: string\|null, archived?: bool}]}` |
| `teammate.chat` | `{id}` | `{id}`: the teammate's chat, a session like any other |
| `teammate.update` | `{id, name?, brief?, icon?, agentKind?, model?, effort?, permissionMode?, lead?}` | `{teammate}`: as `teammates.list` names it now |
| `teammate.create` | `{spaceId, name, handle?, brief?, icon?, agentKind, model?, effort?, permissionMode, lead?}` | `{teammate}` |
| `teammate.archive` | `{id, archived?: bool}` | `{teammate}` |
| `teammates.setLead` | `{spaceId, id: string\|null}` | `{teammates: [Teammate]}`: the space's, in order |
| `teammates.reorder` | `{spaceId, order: [{id, group: string\|null}]}` | `{teammates: [Teammate]}`: the space's, in order |
| `usage.get` | `{}` | `{limits: [PlanLimits], spend: Spend}` |
| `reviews.list` | `{}` | `{reviews: [ReviewSummary]}` |
| `review.get` | `{id}` | `{review: ReviewSummary, items: [ReviewItem]}` |
| `review.decide` | `{id, decision: "approve"\|"changes"\|"reject", note?}` | `{review: ReviewSummary}`, as it now is |
| `review.file` | `{id, path}` | as `session.file`'s |
| `schedules.list` | `{}` | `{tasks: [ScheduledTask]}` |
| `schedules.runNow` | `{id}` | `{task: ScheduledTask}`, with the run it started |
| `session.send` | `{id, text, delivery?: "auto"\|"queue"\|"steer", attachments?: [Upload], mentionRefs?: [MentionRef], tabs?: [TabRef]}` | `{ok: true}` |
| `session.composer` | `{id}` | `{commands: [UserCommand], skills: [{id, name, description}]}` |
| `session.mentionFiles` | `{id, query?: string = ""}` | `{files: [{path, rel}]}` |
| `session.tabs` | `{id}` | `{tabs: [{itemId, kind, title, url?, path?, cwd?, program?}]}` |
| `session.tabPreview` | `{id, tab: TabRef}` | `TabCard` |
| `session.expandCommand` | `{id, name, args?: string = ""}` | `{text, missing: [string]}` |
| `session.goal` | `{id, objective}` | `{ok: true}` |
| `session.goalControl` | `{id, action: "pause"\|"resume"\|"done"\|"drop"}` | `{goal: Goal\|null}`: null once dropped |
| `session.options` | `{id}` | `SessionOptions` |
| `session.configure` | `{id, model?: string\|null, effort?: string\|null, mode?: "build"\|"plan"\|"ask", permission?}` | `SessionOptions`, as they are now |
| `session.answer` | `{id, requestId, decision: "allow"\|"allow_always"\|"deny", answers?: {<question id>: <value> \| [<value>]}}` | `{ok: true}` |
| `session.stop` | `{id}` | `{ok: true}` |
| `session.seen` | `{id, seq}` | `{ok: true}`. It marks the session read up to `seq`, and never moves backwards. |
| `session.create` | `{spaceId, agent, text, model?, effort?, mode?, permission?, attachments?: [Upload]}` | `{id}` |
| `agents.list` | `{}` | `{agents: [AgentOptions], defaultAgent: string\|null, midTurn: "queue"\|"steer", attachments: Limits, lastModels?: {[agent]: string\|null}, teammatePermission?}` |
| `session.changes` | `{id, checkpointId}` | `{checkpointId, files: [{path, oldPath, status, additions, deletions}], totalFiles}` |
| `session.diff` | `{id, checkpointId, path, from?: int = 0}` | `{path, oldPath, status, binary, additions, deletions, lines: [string], from, next: int\|null, total, truncated, truncatedReason}` |
| `session.file` | `{id, path}` | `{path, name, size, mime, preview: {kind: "image", mime, data} \| {kind: "text", text, truncated} \| {kind: "none", reason}}` |
| `session.fileData` | `{id, path, from?: int = 0}` | `{path, name, size, mime, from, data, next: int\|null, modifiedAt?: int}`: `data` is up to 512 KB of the file from `from`, base64; `modifiedAt` is when the file last changed, and a phone from before it does not ask. A `from` past the end answers with no bytes, which is how a phone asks whether a copy it kept is still the file. |
| `space.icon` | `{id}` | `{mime, data}`: base64 |
| `session.screens` | `{id}` | `{screens: [Screen]}`: the live first, then by name |
| `session.screen` | `{id, screenId, kind: "simulator"\|"machine", maxSide?: number = 1000}` | `{mime: "image/jpeg", data, width: int, height: int, capturedAt: ms}`: `data` is base64 |
| `session.panes` | `{id}` | `{browsers: [BrowserPane], terminals: [TerminalPane]}`: each kind live first, then by name |
| `session.browserFrame` | `{id, browserId, maxSide?: number = 1000}` | a frame, as `session.screen` answers one, with every password field covered |
| `session.terminal` | `{id, terminalId, cursor?: {runId, seq}\|null = null}` | `{runId, seq, text, reset: bool, running: bool}` |
| `session.moveOptions` | `{id}` | `MoveOptions` |
| `session.move` | `{id, to: {kind: "checkout", environmentId} \| {kind: "worktree"}, when?: "now"\|"after-turn"\|"stop" = "now"}` | `{session: SessionRow}`, once the move is done, or queued for `after-turn` |
| `session.cancelMove` | `{id}` | `{cancelled: bool}`: false when there was nothing left to stop |
| `session.delete` | `{id}` | `{ok: true}` |
| `session.fork` | `{id, agent?}` | `{session: SessionRow}`: the fork |
| `session.moveToSpace` | `{id, spaceId}` | `{session: SessionRow}`, in the space it is in now |
| `session.switchAgent` | `{id, agent, model?: string\|null}` | `{session: SessionRow}` |
| `session.accounts` | `{id}` | `{accounts: [{id, label, email: string\|null, cliDefault: bool, signedIn: bool\|null}], current: string\|null}` |
| `session.setAccount` | `{id, accountId}` | `{session: SessionRow}` |
| `session.saved` | `{id}` | `{seqs: [int]}` |
| `session.setSaved` | `{id, seq, saved: bool}` | `{seqs: [int]}`: the session's saved turns now |
| `saved.list` | `{profileId}` | `{entries: [SavedTurn], total: int}` |
| `documents.list` | `{spaceId, dir?: string = "", offset?: int = 0, limit?: int = 100}` | `{folder, entries: [DocumentRow], total: int, next: int\|null}`: `limit` is at most 200; `folder` is the folder's name |
| `documents.search` | `{spaceId, query}` | `{entries: [DocumentRow], withheld: DocumentRow\|null}`: at most 50 |
| `documents.file` | `{spaceId, path}` | as `session.file` |
| `documents.fileData` | `{spaceId, path, from?: int = 0}` | as `session.fileData`, and `modifiedAt` |
| `library.files` | `{profileId?, spaceId?, origin?: "output"\|"upload"\|"added", query?: string = "", before?: {ts, id}, limit?: int = 40}` | `{entries: [LibraryFile], next: {ts, id}\|null}`: `limit` is at most 100 |
| `library.file` | `{path}` | as `session.file` |
| `library.fileData` | `{path, from?: int = 0}` | as `session.fileData`, and `modifiedAt` |
| `memory.overview` | `{profileId}` | `{places: [MemoryPlace], homes: [{sourceId, spaceId: string\|null, label}], learning: bool}`: each place's newest 5 of its `count` |
| `memory.list` | `{profileId, place?, query?: string = "", offset?: int = 0, limit?: int = 100}` | `{entries: [MemoryRow], total: int, next: int\|null}`: `limit` is at most 200 |
| `memory.file` | `{id, profileId}` | `MemoryFile` |
| `memory.write` | `{id, profileId, text, confirmExternal?: bool, baseUpdatedAt?: number}` | `MemoryFile`: `text` is at most 100,000 characters |
| `memory.create` | `{profileId, sourceId, spaceId?, name, description, type: "user"\|"feedback"\|"project"\|"reference", body}` | `MemoryFile` |
| `memory.delete` | `{id, confirmExternal?: bool}` | `{trashed: bool}`: true where a file outside Realm went to the Trash |
| `memory.setLearning` | `{profileId, on: bool}` | `{on: bool}` |
| `debug.report` | `{name, data}` | `{ok: true}` |

`Space` is `{id, name, icon, color, sessions: [SessionRow], more: int, iconKind?, glyph?, emoji?, profileId?}`.
`iconKind` reads `icon` as the desktop does: `glyph` (a Hugeicons glyph, by `glyph`), `emoji` (`emoji`),
or `picture` (the person's own picture, which `space.icon` sends).

`Profile` is `{id, name, icon, color, iconKind?, glyph?, emoji?, needsYou: int}`: a set of spaces, as the
desktop's sidebar switches between them. Its icon is read as a space's is; a profile's own picture is
not sent. `needsYou` is how many of `home.get`'s `needsYou` are in its spaces.

**Home is one profile's, and every profile's.** `profiles` lists every profile in the desktop's order.
Each space names its `profileId`, and keeps its five most recently active rows and how many more it
has, whichever profile is asked for. `needsYou` stays every profile's, so nothing that waits is hidden,
and keeps the sidebar's order. `recent` is the scope that changes: at most 40 (`RECENT_LIMIT`) listed
sessions of the profile `profileId` names, most recently active first, and every profile's when none
is named. `profileId` in the answer is the scope `recent` was gathered for: null for every profile,
which is also the answer to a profile the Mac no longer has.

A **listed** session is a session item that is not archived, the rule Home has always used: the quick
chat and an archived session are no rows. `space.sessions` pages one space's listed sessions in Home's
order, so its first page is the space's five on Home, and `more` says whether a page follows.

**Home's order** is `activityAt`, newest first; a tie goes to the session made later, then to the
larger id. Every read of the same lists orders them the same way, so pages neither repeat nor skip a
session.

**A session with no model** runs its agent CLI's own default, and `modelLabel` names what is known
of it: once it has run, the model its newest handshake (`init`) reported, on `session.open`'s row and
in `session.options`; before then, the model the Mac's probe marks as the CLI's default. Where the probe
marks none and the agent's models are Realm's curated list (Claude, DeepSeek), it is "Default" rather
than the list's first model, which the CLI may not run. Home's and a space's rows read no handshakes,
so a row there names the probe's default. A default's row in `AgentOptions.models` is named the same
way: by the handshake in `session.options`, by the probe alone in `agents.list`.

**A session's settings are the desktop's chips.** `session.options` answers with the session's agent,
as `AgentOptions`, and what it is on now:

```
SessionOptions {
  agent: AgentOptions,
  model: string|null,          the model it was given, or null for its agent's default
  modelLabel: string,          the model as the chip names it; with none given, as SessionRow's
  effort: string|null,
  permissionMode: string|null, as SessionRow's
  midTurn: "queue"|"steer",    what a message typed while a turn runs does on this Mac (`sessions.midTurnMode`)
  attachments: Limits
}

AgentOptions {
  kind, name, mark,            the agent, as SessionRow's agent, agentName and agentMark
  available: bool,             installed and signed in, as far as the Mac's last look found
  note: string|null,           why not: "not installed" or "signed out", as the desktop's agent chip says
  models: [{id: string|null, label, efforts?: [Choice], defaultEffort?: string|null}],
  efforts: [Choice],           reasoning levels that are the agent's own setting rather than a model's
  defaultEffort?: string|null, which of those it runs while none is chosen, where it names one
  modes: [Choice],             Build, then Plan and Ask where the agent has them
  permissions: [Choice],       least to most free; empty where Realm cannot set them for this agent
  steerNote: string            what Steer does to this agent's running turn, in words
}

Choice { id, label }
Limits { maxCount: int, maxBytes: int, maxTotalBytes: int }   6 files, 8 MB each, 10 MB in all, in bytes
```

- **Models** are the ones the desktop's picker lists for that agent: the Mac's probe of it, else
  Realm's curated list, named as the picker names them under the agent's mark ("Opus 5.5"). `id: null`
  is the agent's own default, named by its default's name, and comes first. A session that was given a
  model cannot be put back on its default, so its list leaves `null` out.
- **Levels** are the ones the picker offers: on a Claude or Codex model, the levels that model takes
  (`efforts`, and `defaultEffort` where the harness names one); on any other agent, the agent's own
  (`AgentOptions.efforts`, and `AgentOptions.defaultEffort` beside them: null where the agent does not
  say). An agent that takes none has none. They are named as the desktop names them: Low, Medium,
  High, XHigh, Max.
- **Modes** are the ones the agent offers: Plan and Ask on Claude and Codex, and on an ACP agent the
  ones it named for that session.
- **Permissions** are Ask each time (`default`), Accept edits (`acceptEdits`) and Full access
  (`bypassPermissions`), where Realm can set them.
- The Mac does not wait on a slow agent to answer: with no probe of that agent made yet, it asks that
  agent alone for a moment, then answers from the curated list.

`session.configure` checks each value it is given against the session's options, and sets only what
changes, as the desktop's chips do (`sessions.setOptions`). A field left out stays as it is. A value
the agent does not offer is `INVALID_PARAMS`, and nothing changes.

- **Plan and Ask** travel as the permission mode: `"plan"` and `"ask"`.
- **Build** sets the `permission` given with it; else the session's own rung, when it is in Build
  already; else the Mac's default for new sessions (`sessions.defaultPermissionMode`); else
  `"default"`. A `permission` without a `mode` is Build on that rung, and one with Plan or Ask is refused.
- **A level** must be one the model takes, the model given with it where one is.
- **`model: null`**, the agent's default, is refused for a session that was given a model: the Mac
  cannot put a session back on its default.

**Files go with a message.** `session.send` and `session.create` take `attachments`, each an `Upload`:

```
Upload { name: string, mime: string, data: string }   data: the file's bytes, base64
```

- **The message**: `text` may be empty when files go with it. A message with neither is
  `INVALID_PARAMS`.
- **The checks**, before anything is written: at most `maxCount` files, each at most `maxBytes` and
  all at most `maxTotalBytes`; `data` must be base64 exactly as it encodes; `mime` must be a media type.
  A picture must be a JPEG, PNG, GIF or WebP, the kinds every agent takes inline, and its bytes must be
  that kind. Any refusal is `INVALID_PARAMS`, with words a person can act on, and nothing is written.
- **Where each goes**: where a desktop paste goes, `<home>/tmp/attachments/<random>-<name>`, under the
  name the desktop's own sanitiser makes of `name` (a picture gains its type's extension where its name
  has none). The folder is swept of files older than a day, as the desktop sweeps it.
- **Then** the session is sent their paths and types, as the desktop's prompter sends a pasted file, and
  its `user_message` keeps them: the user row's `attachments`.

`session.create` checks the model, level, mode and permission it is given as `session.configure` does,
against a new session of that agent, and checks its files, before it makes the session: a refusal
leaves nothing behind. What it is not given is the Mac's own default. `agents.list` answers with
`AgentOptions` for every agent the desktop's new session offers, in its order; `defaultAgent` is the one
the desktop's "+" would reach for (the agent last chosen, else Claude).

A phone offers files only to a Mac that answers `session.options`: an older Mac would drop them.

**Needs you is the desktop's.** `home.get`'s `needsYou` is the sidebar's own rule, `needsYou` in
`@realm/view`, run on the lists the sidebar is seeded from: `sessions.listAll`, `items.listAll`,
`spaces.list`, and the quick chat's session from the `ui.quickChat` setting. So it leaves out the quick
chat, a sub-agent waiting under a lead that is a row, a failure that has been read and an archived
one, and it orders the waiting by how long each has waited, then the failures.

**A session's row is the sidebar's.** `session.update` renames, pins or archives the session's own
item, as the desktop's sidebar does (`items.update`), and changes only what it is given. A name is
trimmed, and none is `INVALID_PARAMS`. The answer is the row as it now is, or `session: null` once it
is archived: an archived session leaves every list. The row is found among its space's items, archived
ones included, so `archived: false` takes back one put away. A session with no row is `NOT_FOUND`.

**The composer's `/` and `@` are the desktop's.** The phone draws both lists, and builds what it can
from what it already holds: the modes from `session.options`, the teammates from `teammates.list`.
`session.composer` answers with the rest:

```
UserCommand { name, description, argumentHint: string|null }   the person's own commands, as `/name`

MentionRef  { kind: "role", label, roleId }                     a teammate, by its id
          | { kind: "file", label, path }                       a file in the session's folder
```

- **Commands** are the ones the desktop's `/` list runs: valid, and not overridden by a closer folder
  (`runnableCommands`). One with an `argumentHint` waits for its words; `session.expandCommand` fills
  its template in with them (`commands.expand`), and the phone puts the text in its composer, as the
  desktop does, rather than sending it. A `$2` the words did not reach stays in `text`, named in
  `missing`.
- **Skills** are the ones an `@` hands the session's agent: the space's enabled skills where the agent
  is given Realm's skills, and the `mac` skill wherever the space has it, on or off.
- **Files** are the session's folder's, as the desktop's `@` ranks them for `query` (`mentions.files`):
  `rel` is where it is in the folder, `path` where it is on the Mac. A file that holds a secret is left
  out.
- **Tabs** are the session's space's panes, as the desktop's `@` lists them (`tabs.list`), in the
  space's order: its browser tabs by page, its documents by the file each shows, its terminals and its
  simulators. A pick is a card beside the draft, not words in it; `session.tabPreview` reads the pane
  as a send would and says what it comes to, and `session.send`'s `tabs` hands the cards over, at most
  8. The Mac reads each pane again as the message goes, into one `<tab kind=… title=… url|path=…>`
  block the agent is handed after the words, and the user row keeps the cards. A message of tabs
  alone is a message. A terminal also says where it runs (`cwd`, from `~` where it can) and the name
  of the program in front of it (`program`, absent at its shell), so a phone can tell two of one name
  apart; an older Mac sends neither.

```
TabRef  { itemId, kind: "browser"|"documents"|"terminal"|"simulator", title }
TabCard { itemId, kind, title, url?, path?, cwd?, program?,
          bytes: int,         what was sent of it: its text's UTF-8 bytes, a simulator's screenshot's
          truncated: bool,    longer than its kind's cap, so the agent got its start (a terminal: its end)
          closed?: true }     gone when it was read, so nothing of it was sent
```

- **`session.goal`** starts a goal on `objective` (`goals.start`), as `/goal` does on the desktop. An
  objective of no words is `INVALID_PARAMS`. A goal set on a session that has one replaces it.
- **`session.goalControl`** is the desktop's goal strip: `pause` an active goal ("You paused it."),
  `resume` a paused, blocked or spent one, which starts a turn, `done` marks an unfinished one
  complete ("Marked done by you."), and `drop` forgets the objective, never the work. A resume the Mac
  refuses, of a goal running or finished, is `FORBIDDEN` in its words.

```
Goal {
  objective: string,
  status: "active"|"paused"|"blocked"|"budget_limited"|"complete"|"abandoned",
  turns: int,               turns run under it, the first included
  tokensUsed: int,
  tokenBudget: int|null,    its ceiling, or null for none
  note: string|null,        why it stopped, in the agent's words or Realm's
  startedAt: ms, updatedAt: ms
}

Todo {
  content: string,
  status: "pending"|"in_progress"|"completed",
  activeForm: string|null   what an item in progress says it is doing ("Running the suite")
}
```

- **`todos`** is the agent's to-do list as it stands: the session's newest `TodoWrite`, in the order
  the agent wrote it, as the desktop's strip above the prompter draws it. A sub-agent's list is its
  own, not the session's; an empty or unreadable list clears it.
- **A message names things as the desktop's does.** A teammate or a file is `@[label]` in `text`, and
  `mentionRefs` says what each label is; a skill is `@id`. The Mac sends the session the skills the
  words name, scanned against the ones `session.composer` lists, and the refs whose `@[label]` is still
  in the words, at most 12. A teammate named is passed the message in its own chat first. A file
  outside the session's folder, or one that holds a secret, is `INVALID_PARAMS`, and nothing is sent.
- A Mac older than these calls answers `METHOD_NOT_FOUND`: the phone offers the modes, `/goal` is
  left out, and `@` lists the teammates alone, sent as words.

**The queue is the Mac's.** A message typed while a turn runs waits in the Mac's queue, and goes out
when the turn ends, one per turn, in the order it was asked:

```
QueuedMessage {
  id, text,
  attachments: [{path, name, mime}],   named as its user row will name them, and previewed by `session.file`
  at: ms,                              when it was queued
  held: bool                           someone is editing it, on the Mac or a phone
}
```

- **Held**, a message does not go out, and nothing behind it does, until the edit is saved or let go.
  A hold lets go on its own after a while, so an editor closed half way cannot stop the queue.
- **`session.sendQueuedNow`** sends it now, ahead of the turn it was waiting for, as the desktop's
  Send now does (`sessions.releaseQueued`). **`session.removeQueued`** takes it out unsent
  (`sessions.dequeue`). A message that has already gone out is left as it is.
- **`session.holdQueued`** holds it while it is edited here, or lets it go. A hold on a message that
  has already gone out is `NOT_FOUND`: there is nothing left to edit.
- **`session.editQueued`** gives it new words, keeping its files and its place, and lets its hold go
  (`sessions.editQueued`). It is `NOT_FOUND` once the message has gone out, so the phone can put the
  words back in its composer; no words at all, on a message with no file, is `INVALID_PARAMS`.

`session.open` answers with the queue as it was when the session opened, and `session.queue` (the
event) carries the whole queue each time it changes after that. Both carry `move` beside it: a move
of the session that is not over, which waits ahead of the queue.

**A session's sub-agents are its Agents tab's.** `session.subagents` lists every session it started
(`delegation.children`), newest first:

```
Subagent {
  session: SessionRow,       its own session, which opens like any other
  goal: string|null,         what it was asked to do
  startedAt: ms,
  settledAt: ms|null,        when it finished; null while it works
  outcome: string|null,      how it ended, in the Agents tab's word; null while it works
  report: string|null,       its last answer, the report its lead read: at most 2,000 characters
  note: string|null          why Realm stopped it itself, where it did
}
```

- **The outcome** is `done`, `failed`, `timeout`, `stopped` or `cancelled`: the state the Agents tab
  reads off the run's record and the session (`subagentState` in `@realm/view`). A sub-agent working,
  waiting on the person, or about to start its first turn has none, and no `settledAt`; its row's
  `status` says which. One whose tool keeps no record (a browser agent, a reviewer) ended when it
  last did anything, and is `done` when it said something.
- `session.subagents` (the event) says the list changed: one started, settled, was collected, or
  changed its status. It is sent to phones with the lead open, once for changes that come together.

**A teammate's chat is a session.** `teammates.list` names every space's teammates, space by space,
each space's Lead first and the rest in its Team list's order; archived ones are left out.
`chatId` is the session that is its chat, null until it has one. `teammate.chat` answers with the session that is the teammate's chat (`teammates.home`), making it
when the teammate has none yet or its chat was deleted. A phone opens and sends to it as to any
session. An archived teammate has no chat to give. A Mac older than these calls answers
`METHOD_NOT_FOUND`, and a phone offers no teammates.

Each teammate also carries what its sidebar row shows: its `icon` (a shape and a colour, by the
desktop's names), its `state` (`idle`, `working`, `needs-you`) since `stateSince`, whether its chat is
`unread`, and `activity`, the title of its live task session or else its newest one, with when that
session last moved. `agentKind`, `model`, `effort` and `permissionMode` are what its Edit sheet shows.
A Mac from before these fields leaves them out, and a phone draws the teammate without them.
`home.changed` is sent when a teammate changes, as when a session does.

`teammate.update` is the Edit sheet's save (`teammates.update`): its name, brief, icon, model and
reasoning level, permission (one of the three rungs the desktop sheet offers) and whether it is the
Lead. Anything left out keeps its value. It answers with the teammate as `teammates.list` would name
it. A teammate the Mac does not have is `NOT_FOUND`.

**The Team is made and kept from a phone as from the Mac.** `teammate.create` is the New teammate
sheet's Create (`teammates.create`): a name, what it does, an icon, an agent, model and level, one of
the three permission rungs, and whether it is the Lead. A `handle` left out is made from the name and
numbered where another teammate has it; one sent is lowercase letters, digits and dashes, and one the
space already has is `INVALID_PARAMS` with the Mac's words ("@cto is already a teammate here"). The
Mac makes the teammate's chat with it. `agents.list` says what the sheet starts on, as the desktop's
does: `lastModels`, the model each agent's last message was sent on (null for its default), and
`teammatePermission`, the permission new sessions start in where that is one of the three rungs, else
`default`.

`teammates.setLead` makes a teammate its space's Lead, taking it from the one that was, or leaves the
space with none (`id: null`); an archived teammate is `FORBIDDEN`. `teammate.archive` puts one away
(`teammates.archive`): it leaves the Team list and stops being the Lead, and its sessions stay where
they are. `archived: false` brings it back, under a handle nobody took meanwhile.
`teammates.list` with `archived: true` names only the ones put away, each with `archived: true`; a Mac
from before it names its listed teammates instead, which a phone tells by `archived` being absent.
`teammates.reorder` is the Team list dragged into a new order (`teammates.reorder`): every teammate in
the space, top to bottom, each with the section (`group`) it sits in. The Lead stays first whatever
the order says. Each of these answers as `teammates.list` names teammates, and sends `home.changed`.

A message an agent sends a teammate (`team_message`) is a `tool` row carrying `teammate`: the id of
the teammate it went to, resolved as the server resolves `to` (its handle, `@handle` or `lead`), null
where the space has none by that name; the handle; and the words without the "From @handle: " the
server puts in front of them. In the teammate's own chat, that message is a `user` row with the
sender's `teammateId`, its text without the prefix.

**Usage is Settings ▸ Usage.** `usage.get` answers with each agent's plan, as the page draws it, and
this calendar month's spend:

```
PlanLimits {
  agent, agentName, agentMark,     as SessionRow's agent, agentName and agentMark
  plan: string|null,               the provider's word for the tier, as it wrote it ("max", "pro")
  windows: [{id, label, usedPercent: number|null, resetsAt: ms|null}],
  alert: string|null,              the provider's warning, in words ("Weekly limit nearly reached")
  alertLevel?: "approaching"|"exceeded"|null,   how far it goes
  alertWindow?: string|null,       the window it is about; null for every window
  unavailable: string|null,        why there is nothing to draw, in the page's sentence
  at: ms                           when the provider was last heard from; 0 for never
}

Spend {
  monthToDate: number,             US dollars spent this calendar month
  budget: number|null,             the monthly budget set on the Mac, or none
  topSessions: [{id, title, spaceName, cost: number}]
}
```

- **Every agent a person can run** has a row, in the order the desktop offers them, which puts the
  two that report a plan first. An agent that cannot report one says so in `unavailable` ("Cursor does
  not report plan limits."), and so does one that reports and has not run yet.
- **Windows** come fullest first, as the page draws them. `usedPercent` is 0 to 100, and null where the
  provider named a window but not how full it is, or where the window has reset since the reading:
  that figure was about a period that is over. Neither is ever drawn as a zero.
- **`alert`** is the provider's own verdict, never a threshold the Mac chose: `<window> limit reached`
  or `<window> limit nearly reached`, or `Limit …` where the provider named no window. A warning about
  a window that has since reset is over, and null. `alertLevel` and `alertWindow` say the same for
  drawing: the window named, or every window where none is, takes the warning's tone, as on the page.
  An older Mac sends neither.
- **Spend** is the page's: this calendar month on the Mac's clock (`usage.summary`), reported and
  estimated dollars together. `topSessions` are the five that cost the most this month, most first,
  each by the name its sidebar row has.

**Review is the desktop's Review.** `reviews.list` lists what every team has handed back and is still
open, across every space, newest first by `updatedAt`:

```
ReviewSummary {
  id, spaceId, spaceName,
  roleName: string|null,
  title,
  kind,                      the role's label for it, as the desktop keeps it ("slideshows", "message", "launch")
  state,                     "waiting" for the person, "changes" sent back, or "approved" and not yet done
  itemCount: int,
  to: string|null,           who its first item goes to, where it names someone
  channels: [string],
  note: string|null,         the person's last note: what they asked to change, or why they said no
  sessionId: string|null,    the role's session
  updatedAt: ms
}

ReviewItem {
  id,
  title: string|null,        an email's subject
  body: string,              the draft: its own words, or the text of the document, table or diff it is
  channel: string|null, to: string|null,
  files: [{path, name, mime}]    its pictures, by their paths in the space's folder
}
```

- **Open** is every state a review does not rest in: `done`, `rejected`, `closed` and `dismissed` are
  final, and leave the list.
- **`review.decide`** decides as the desktop's buttons do: `approve` is `team.reviewApprove`, `changes`
  is `team.reviewRequestChanges` with the note, and `reject` is `team.reviewReject`, with the note as
  its reason where there is one. Asking for changes without a note is `INVALID_PARAMS`. Approving posts
  and sends nothing: each outward act is still pressed on the Mac. A decision the review's state
  refuses (approving one already approved) is `FORBIDDEN`, in the Mac's words.

**Scheduled is the desktop's Scheduled page.** `schedules.list` lists every space's scheduled tasks
in the page's order: what runs soonest first, then those paused or with nothing left to run, the
newest of those first.

```
ScheduledTask {
  id, spaceId, spaceName, title,
  when: string,              when it runs, as the page says it ("Weekdays at 9:00 AM", "Every hour at :15")
  enabled: bool,
  nextRunAt: ms|null, lastRunAt: ms|null,
  lastRun: {state: string, sessionId: string|null, unread: bool} | null
}
```

- **`when`** is the page's sentence for the task's expression, on the Mac's clock; an expression the
  page cannot put in words is given as itself.
- **`lastRun`** is the run the task's last firing made, or null when it has made none or that run is
  gone. Its `state` is the page's word: `Starting`, `Running`, `Needs you`, `Failed`, `Expired` or
  `Stopped`, and `Finished` for a run that succeeded. It is `unread` until its session has been read
  to the end, a session nobody has opened included.
- **`schedules.runNow`** is the page's Run now: one run, now, without moving the task's own clock. A
  task that continues one session refuses another run while its last is still going (`FORBIDDEN`).

**A session's screens are its space's.** `session.screens` lists every simulator and machine the
session's space has open on the Mac: each a pane with a screen in it, whichever session opened it. A
Mac app (a machine that shows an app on the Mac itself) is left out: a picture of one is a snapshot of
the app by the helper an agent's computer use acts through, which keeps one snapshot per app, so a
phone watching it would leave the agent's own snapshot stale.

```
DocumentRow {
  path,                      relative to the space's folder, `/`-separated
  name,
  isDir: bool,
  size: number,              bytes; 0 for a folder
  kind: string,              the desktop's `documentKindFor` ("doc", "code", "pdf", "preview", "video", ...),
                             or "folder"
  mime: string               "" for a folder
}

LibraryFile {
  id,
  path,                      the file's full path on the Mac
  name,
  origin: string,            "output" made by an agent, "upload" attached by the person, "added" added by them
  at: number,                when it was last touched
  sessionId: string|null,    null for a file the person added, as are the next two
  sessionTitle: string|null,
  spaceId: string|null,
  kind: string,              as DocumentRow's
  mime: string
}

Screen {
  id,
  kind: "simulator"|"machine",
  name,                      what its pane is called: its sidebar row's title ("iPhone 17 Pro")
  detail?: string,           what it is, in words: "iOS Simulator", "Android emulator", "Your iPhone" or
                             "Your iPad" for a real one on the Mac's cable; "Remote screen" or "Virtual
                             machine" for a machine
  live: bool                 there is a picture to take now: the simulator's pane is showing pixels, the
                             machine is running (connected, or booted)
}
```

- **Order**: the live first, then by name as a person reads a list, then by id. A space with none
  answers an empty list.
- **`session.screen`** is a picture of one of them as it is now, for a phone watching it: a JPEG no
  longer than `maxSide` on its longer side, and never enlarged. `maxSide` is brought inside 320 to 1280
  (`SCREEN_SIDE`), not refused, and is 1000 when none is given. A frame is never heavier than 320 KB:
  a heavier one is made again at seven tenths of the side, then at half of it, plainer each time, and
  one heavier still is not sent (`INTERNAL`). A phone's screen at 1000 is usually well under it.
  `width` and `height` are the JPEG's own; `capturedAt` is when the Mac took it.
- **Only its own space's**: a screen that is not one `session.screens` lists for that session, or is
  listed under the other kind, is `NOT_FOUND`, exactly as one that never existed; a Mac app in the
  session's own space is `FORBIDDEN`, as one that is not live. One that is not live is `FORBIDDEN`,
  in the Mac's words: asking again will not change that until the list does. A live one the Mac could
  not picture just then (a phone's runner not answering, a capture that was no picture) is `INTERNAL`,
  in the Mac's words too: the next call may bring one.
- **Polled**, about once a second or two while the phone's viewer is open. The Mac takes a picture
  through the same capture an agent's look takes, one of a screen at a time: the calls for it that come
  while it is being taken (the viewer's, the session card's, another phone's) share it, each made at
  its own `maxSide`. A picture not made within ten seconds is given up on (`INTERNAL`), well inside the
  phone's own wait, and the next call takes a new one. The Mac keeps nothing of it, and writes nothing
  into the space's folder, but the picture passes through the system's temporary folder on its way: an
  iOS Simulator's capture as the full-size PNG `simctl` writes, every capture again in a folder of its
  own for `sips` to read, and each JPEG `sips` makes in another. Each is removed once read, before the
  answer goes — or, when the answer was that the picture took too long, once the work behind it ends —
  and what a server that stopped part way left there is cleared by the next one to start, once it is
  ten minutes old.

**A session's panes are its space's too.** `session.panes` lists the browser and terminal panes the
session's space has open on the Mac — the desktop's own names for them — whichever session opened
them. A closed pane is not listed.

```
BrowserPane {
  id,
  name,                      what its tab is called: the page's title
  url,                       the address it shows, "" for a blank tab
  favicon?: {mime, data},    the page's own icon, base64: PNG, JPEG, GIF, WebP or an icon file; absent
                             when the page offered none, or only an SVG
  live: bool                 its page is loaded in one of Realm's windows: a pane given up for memory,
                             and every pane while Realm has no window open, is not
}
TerminalPane {
  id,
  name,                      what its pane is called
  detail,                    the command it was started with, else where it runs ("~/Code/realm")
  running: bool              its shell or command is running; a command that ended is not
}
```

- **`session.browserFrame`** is a picture of a browser pane's page as it is now, bounded exactly as a
  screen's (`SCREEN_SIDE`, 320 KB, made again smaller twice) and taken by Realm's window from the pane's
  own view. **Every field that could hold a secret is covered before the picture leaves the app**: a
  password field (its dots, and its text once a page's Show password has made it plain), and any field
  whose type, name, id or autocomplete names a password, a one-time code, a token or a card's number or
  security code is painted over in flat grey, a little past its edges. Such a field inside a frame of
  the page cannot be placed in the picture, so while one is on the page there is no picture: the answer
  is `INTERNAL`, in the Mac's words, and the next call may bring one. A pane not live is `FORBIDDEN`,
  and its page is never loaded to answer.
- **At most one picture of a pane a second.** Every call for a pane within a second of its last picture
  — the viewer's, another phone's — is answered with that picture. A phone asks about once a second
  while its viewer is open, and nothing while it is not: listing the panes takes no picture.
- **`session.terminal`** is a terminal's output since `cursor`, as its pty wrote it, ANSI escapes and
  all, for a phone to draw. Following on from the cursor it last read, only what came after
  (`reset: false`). With no cursor, a cursor of another run (the shell started again), or a gap the Mac
  no longer holds, it is the whole of what the Mac holds — the screen the terminal's last shell left,
  then this one's output — as `reset: true`. More than 64 KB (`TERMINAL_TEXT_MAX`) is cut to its end,
  from the first line that starts inside it, and is `reset: true` too. A read never starts a terminal
  that has not started since the Mac's Realm did. A shell echoes no password typed at its prompt, so
  none is in its output.
- **Read only.** No call writes to a terminal, resizes one, or acts on a page: a phone only looks.

**A session moves within its Mac.** `session.moveOptions` is what the desktop's Move sheet reads:

```
MoveOptions {
  mac: string,               the Mac it runs on
  from: Checkout,            the checkout it runs in now
  busy: bool,                a turn is under way: Move after this turn, or Stop and move
  blocked: string|null,      why it cannot move at all, in the Mac's words (a teammate's chat, a
                             sub-agent still running), or null
  pending: bool,             a move is queued behind the turn, or under way
  conversation: "native"|"notes",
                             the agent resumes the conversation there, or is handed it as notes
  changedFiles: int,         uncommitted files in its checkout, which go with it
  leftBehind: [string],      what stays, by name: the terminal, ignored files that look like secrets
  stops?: [string],          what the agent runs beyond its turn (a background task, a command),
                             which only `stop` stops; any other move is refused while it runs
  checkouts: [Checkout],     the space's other checkouts it can move to
  worktree: {available: bool, reason: string|null}
                             whether a new worktree can be made for it
}
Checkout { environmentId, path, branch: string|null, kind: "primary"|"checkout"|"worktree" }
```

- `path` is shortened against the Mac's home (`~/realm`).
- **`session.move`** is the desktop's `sessions.move`, and the checkout it leaves is left as it was.
  Mid-turn, `now` is refused, `after-turn` waits for the turn to end (the answer comes once it is
  queued) and `stop` stops the turn, denying any open request, and moves. Messages sent meanwhile wait
  and go once it is over. What the Mac refuses — a teammate's chat, a sub-agent still running, a
  checkout another session is working in, a move already under way, background work only `stop` would
  stop, a move that could not be made — is `FORBIDDEN`, in its words; a move that fails part way puts everything back first.
- A Mac from before moves answers all three `METHOD_NOT_FOUND`, and a phone offers no move.
- **`move`**, on `session.open`, `session.queue` and the `session.queue` event, is the move not over yet:

  ```
  PendingMove { moveId, to: {kind: "checkout", environmentId} | {kind: "worktree"},
                step: "preflight"|"freeze"|"snapshot"|"place"|"boot"|"commit"|null }
  ```

  `step` is null while it waits for the turn to end, and the step it is at once under way. The
  progress row is drawn from the stored steps in `rows`, not from `move`. `move` is null once it is
  over, and absent from a Mac before it was sent.

**Opening a session subscribes the channel to it.** From then until `session.close` or the end of
the channel, the Mac sends that session's `session.rows`, `session.status`, `session.hint`,
`session.queue`, `session.subagents`, `session.goal` and `session.todos` events. A change to the queue that comes while the session is
still opening is not sent: the open's answer carries it.

**Answers are the desktop's shape.** `answers` maps a question's `id` (its `question` on a Phase 1
Mac) to an option's `value` or words of the person's own; a multi-select question's answer is a
list. The Mac holds them to the request's card, as it holds the desktop's. A Phase 1 phone's
`{<question>: <label>}` is still accepted.

**The session actions are the desktop's menus'.** `session.delete` deletes, as the desktop's Delete
does: the agent is stopped and the transcript and row go; nothing is archived. `session.fork` takes a
checkpoint of the session as it is now and forks from it, as Checkpoints ▸ Fork… does from the one
picked: a new worktree restored to it, and a new session in it named `Fork: <title>`, with the
conversation carried in as text; `agent` forks onto another agent. `session.moveToSpace` is the
sidebar's Move to space…: a session that has run takes its checkout along. `session.switchAgent` is the
model picker's switch: the new agent starts fresh with a summary of the conversation. `session.setAccount`
runs the session on another of its agent's logins, where the conversation picks up where it left off,
or from notes where it cannot; `session.accounts` lists the agent's logins, and none for an agent with
no accounts. A switch of either kind mid-turn, and a fork of a session whose folder is not a git
repository, is refused (`FORBIDDEN`) in the Mac's words.

**Saved turns are the prompts'.** `seq` is a `user` row's: the turn it starts. `saved.list` is the
desktop's Library ▸ Saved for one profile, the newest saved first. `SavedTurn` is `{sessionId, seq,
savedAt, at, text, attachments: [string], reply: string|null, sessionTitle, spaceId, spaceName}`: `at`
is when the prompt was sent, `attachments` the names of the files an attachment-only prompt carried,
and `reply` the start of its answer.

`debug.report` exists only in development builds. The Mac writes it to `<home>/remote/reports/`.
Phase 1 uses it to bring the phone's measurements back.

### What each call exposes

`mobile.v1` is an allowlist: a call that is not in it does not exist. What the later calls let a
phone read, and what bounds it:

- **`session.changes`**: the paths, statuses and line counts of the files one turn of that session
  changed, as that turn's own `turn_changes` recorded them. A checkpoint of another session is not
  found. At most 200 files.
- **`session.diff`**: the patch of one of those files, between the two trees that turn recorded. The
  path must be one the turn's changes list, or the call is refused (`FORBIDDEN`) without git being
  asked; the phone names no tree. The Mac caps a patch at 512 KB and 4,000 lines, and a page at
  2,000 lines and 256 KB of JSON; a line longer than 4,000 characters is cut, and says so.
- **`session.file`**: a preview of one file that session's `files_made` listed, that one of its
  `user_message`s was sent with, or that a message waiting in its queue carries, by the exact path
  listed, or a refusal (`FORBIDDEN`). A path that is now a link, or not a file, is refused, and so is
  a file that exists to hold a secret (a key, an `.env`), whatever sent it. Its `name` is its user
  row's: the name the person gave it. A picture is sent as a JPEG at most 1024 px on its longer side
  and 512 KB; a text as at most its first 16 KB; anything else as nothing but its name, size and type.
- **`session.fileData`**: the bytes of one of the files `session.file` would preview, refused as it
  refuses, 512 KB to an answer, so a phone can play a video, open a document in Quick Look, or share
  and save the file. A file over 256 MB is refused (`FORBIDDEN`).
- **`session.send`** and **`session.create`**: they write a phone's files, and only into the Realm
  home's `tmp/attachments`, under names the Mac makes. A folder there that is a link elsewhere is not
  written through. The phone names no path.
- **`session.options`**, **`session.configure`** and **`agents.list`**: the agents, models, levels,
  modes and rungs the desktop's pickers offer, and what three settings decide for a phone: what a
  message typed mid-turn does (`sessions.midTurnMode`), the rung Build goes back to
  (`sessions.defaultPermissionMode`) and the agent a new session starts on (`ui.lastAgentKind`).
- **`session.composer`**, **`session.mentionFiles`** and **`session.expandCommand`**: the names,
  descriptions and argument hints of the person's own commands and what one becomes filled in; the
  ids, names and descriptions of the skills; and the paths of the session's folder's files that match
  what was typed, never one that holds a secret, nor anything in them. A skill's instructions and a
  command's file are not sent.
- **`session.tabs`** and **`session.tabPreview`**: a pane's kind, title, page address or file, a
  terminal's folder and its program's name (never its command line), and what a read of it comes to.
  What was read is not sent, and a page's password, one-time-code and card
  fields never leave the Mac in any form: the read hides them by contracts' `isSecretField` rule, the
  one the agent's page read and a phone's browser picture keep. A pane of another space is read as
  closed.
- **`search.query`**: the desktop's ⌘K search, over the sessions of one profile, or of each profile in
  the desktop's order where `profileId` names none the Mac has. `query` is trimmed, 1 to 256
  characters; a phone searches from two, as the palette does. Each session is listed once: those whose
  title matched first, then those where a user or assistant message matched, each group best first as
  the desktop ranks it, at most 20 of each in a profile. `title` is the title with the match marked,
  where it matched; `message` is the best-matching message, by its row's `seq`, and the words around
  the match. A `Snippet` is `[{text, match: bool}]`, runs that join into the words. The palette's other
  groups — terminals, browsers and documents by title, skills, memory — are not sent.
- **`space.icon`**: the picture a person uploaded or had made for a space, at most 256 KB.
- **`session.hint`** and `hint`: the suggested next message the desktop's prompter shows.
- **`goal`, `todos` and their events**: the session's objective, where it stands, its turns, tokens and
  note, and the agent's to-do list's items; a goal's own turns carry the prompt Realm sent.
- **`session.update`**: a session's own sidebar row — its name, its pin, whether it is archived — and
  nothing else of it.
- **The queue's calls**: the messages waiting in that session's queue, each by the id the queue gave
  it; a phone sends, removes, holds and edits only those, and an edit keeps the files they carry.
- **`session.subagents`**: the sessions that session started, each as a row, with the task each was
  handed, how it ended and its last answer.
- **`teammates.list`** and **`teammate.chat`**: each teammate's name, handle, brief, icon, state,
  model and permission, the title of the session it is working in, and the session that is its chat.
  Its folder, clock and task sessions' list stay on the Mac.
- **`teammate.update`**: a teammate's name, brief, icon, model, permission and Lead. Its folder,
  group and clock are not changed from a phone.
- **`teammate.create`**, **`teammate.archive`**, **`teammates.setLead`** and **`teammates.reorder`**:
  a new teammate, in the space's own folder with no clock; a teammate put away or brought back; the
  space's Lead; and the Team list's order. A teammate is never deleted from a phone.
- **`usage.get`**: each agent's plan as its provider last reported it, and this month's spend and
  budget (`usage.budget`), with its five heaviest sessions' names and costs.
- **`reviews.list`**, **`review.get`** and **`review.decide`**: what the space's teams sent to Review,
  the drafts' words and their pictures' paths, and the person's three decisions on it. A draft that is
  a text file is the text the Mac already reads for its own window: at most 256 KB a file and 1 MB a
  review. Approving issues each outward act's ticket; none goes out until it is pressed on the Mac.
- **`review.file`**: a preview, as `session.file`'s, of one picture one of that review's items carries,
  by the exact path `review.get` gave, while it is a file inside its space's folder, through any link.
  Anything else, a file that holds a secret included, is `FORBIDDEN`.
- **`session.panes`**, **`session.browserFrame`** and **`session.terminal`**: the browser and terminal
  panes open in that session's space, by their panes' names, each browser's address and icon; a picture
  of a browser's page as it is now, its password, one-time-code and card fields covered, at most once a
  second and 1280 px; and a terminal's output as its pty wrote it, at most 64 KB an answer. A pane is
  shared by every session in its space, and shows whatever is in it. Nothing a phone sends reaches a
  pane. A pane of another space is not found.
- **`schedules.list`** and **`schedules.runNow`**: every space's scheduled tasks, each with how its last
  run went and that run's session, and Run now. A task's instructions are not sent.
- **`session.moveOptions`** and **`session.move`**: the paths and branches of the session's space's
  checkouts, how many files are uncommitted in its own and the names of the secret-looking files a
  move leaves behind (never their contents). A move goes only to one of those checkouts or a new
  worktree of the session's own; the phone names no path.
- **The session actions**: a session's deletion, a fork of it into a new worktree of its own space, a
  move of it to another space, a switch of its agent or of its login among its agent's, each by the
  desktop's own call. `session.accounts` sends each login's name and email, never its folder or a
  credential.
- **`documents.list`**, **`documents.search`**, **`documents.file`** and **`documents.fileData`**: the
  names, sizes and bytes of what is in a space's folder, read without opening a pane on the Mac. They
  list what the desktop's file picker lists: never a dotfile, nor `.git`, `node_modules`, `dist`, `out`,
  `.next` or `.turbo`. Beyond that a phone is never sent a file that holds a secret (contracts'
  `isSecretPath`, the rule `session.mentionFiles` keeps) nor a link to one, and a read of one is refused
  (`FORBIDDEN`), as is a read of a path outside the folder, whether it says so or a link lands there.
  A linked folder that stays in the folder is listed and a linked file is not, as `session.file` will
  not read one. `withheld` names a file only where the words searched for are that file's name or path;
  a near match to a secret is not said. There is no call that writes a document.
- **`library.files`**, **`library.file`** and **`library.fileData`**: the desktop's Library ▸ Files, one
  row to a file: its name, full path, where it came from and when it was last touched, and the title of
  the session it came from. Only a path the Library lists can be read, by the rules of `session.file`,
  and never one that holds a secret.
- **`memory.overview`**, **`memory.list`**, **`memory.file`**, **`memory.write`**, **`memory.create`**,
  **`memory.delete`** and **`memory.setLearning`**: the desktop's memory library, by its own calls, so a
  save is the same one commit and the Mac's repo stays the only store. Only a file a source lists can be
  read, wherever a link leads, as on the desktop. A row carries a memory's name, description, type and
  where it is kept, each at most 200 characters, and a search's best line, and never its path;
  `memory.file` adds the file's text, at most 100,000 characters, and its path from the home folder. A
  file outside Realm is written or moved to the Trash only with `confirmExternal`, the person's yes. A
  phone is never sent a file `isSecretPath` names, nor one whose text has the shape of a key or a token
  (the shapes memory itself refuses to save): a row of the second kind says only the file's name and
  where it is kept, and a read of it is refused (`FORBIDDEN`). A write with `baseUpdatedAt` is refused
  when the file has changed since, so a phone's slow edit does not overwrite what an agent just saved.
- **`session.saved`**, **`session.setSaved`** and **`saved.list`**: which turns are saved, and for each
  saved turn its prompt, the start of its answer, and its session's and space's names.
- **`session.screens`** and **`session.screen`**: the simulators and machines open in that session's
  space, by their panes' names, what kind each is and whether it is live; and a picture of one of them
  as it is now, at most 1280 px on its longer side, while it is live. A screen is shared by every
  session in its space, and a picture shows whatever is on it: another session's work on a simulator,
  or any window on a machine's screen. A screen of another space is not found.

Beyond those pictures and that output, which show whatever is in a pane the person opened in that
space, no call or event carries a file outside those rules, another session's stream, any other
setting, or a key.

### Events

| Event | Payload | Meaning |
|---|---|---|
| `session.rows` | `{id, rows: [Row]}` | Rows to upsert by key. Text deltas are coalesced to at most ten a second. |
| `session.status` | `{id, status, moving?: true}` | The session's status changed. `moving` as `SessionRow.moving`. |
| `session.hint` | `{id, text: string\|null}` | The suggested next message changed: a newer one after a turn, or none once something was sent. |
| `home.changed` | `{}` | Call `home.get` again. Sent at most once a second. |
| `session.queue` | `{id, queued: [QueuedMessage], move?: PendingMove\|null}` | An open session's queue changed, or its move was queued, reached a step or ended: the whole queue, and the move. |
| `session.subagents` | `{id}` | An open session's sub-agents changed: call `session.subagents` again. |
| `session.goal` | `{id, goal: Goal\|null}` | An open session's goal changed: started, stopped, resumed, counted a turn, or dropped. Home's rows change with it (`home.changed`). |
| `session.todos` | `{id, todos: [Todo]}` | An open session's to-do list changed: the whole list. |
| `session.saved` | `{id, seqs: [int]}` | An open session's saved turns changed, on the Mac or another phone: the whole set. |
| `work.changed` | `{}` | Reviews or scheduled tasks changed somewhere: call `reviews.list` and `schedules.list` again. Sent at most once a second. |
| `pair.result` | see §4.1 | Pairing channels only. |

### Error codes

`METHOD_NOT_FOUND`, `INVALID_PARAMS`, `NOT_FOUND`, `FORBIDDEN`, `SESSION_NOT_LIVE`, `INTERNAL`.

`FORBIDDEN` is also what the Mac answers when it refuses what was asked in the state a thing is in —
a review already decided, a task whose last run is still going, a screen that is not live, a move it
will not make — with its
own words for why.

## 9. What holds this in place

- **Published vectors.** `packages/remote/test/noise-vectors.json` holds the cacophony and snow
  vectors for the three protocols. Both `packages/remote` and `RealmKit` must pass every one.
- **Cross fixtures.** Each implementation writes handshakes for the other to check, with Realm's
  prologues, Realm's payloads and fixed keys:
  - TypeScript writes `packages/remote/test/fixtures/ts-vectors.json`;
  - Swift writes `apps/ios/RealmKit/Tests/Fixtures/swift-vectors.json`.

  Both use the vector file's own format, so the same runner checks them.
- **Frames.** `ts-frames.json` is `{key, messages: [{json, frames: [hex]}]}`. It is made by one
  sending cipher, created with `key` and starting at nonce 0, encrypting every message in order. One
  message is over 150 KB, to cover fragmentation.
- **Links.** `ts-links.json` is `[{url, fields}]`, including an expired link and an unknown version.
- **The API.** `ts-api.json` holds `mobile.v1`'s answers as the Mac's own projector and `MobileApi`
  make them, every row kind included and a user row with files, with the answer the phone's card must
  send for one question, and a payload of each event but the rows, the status, `home.changed` and
  `pair.result`. The server's suite fails when the committed file is not what the code produces, when
  a row kind has no example in it, or when a call that answers more than `{ok: true}`, or one of those
  events, has none; RealmKit decodes every answer in it.
- **The relay.** Its own tests drive §3 against the Worker in workerd, and `scripts/smoke.ts` drives a
  deployed one end to end.
- **Moving relays.** The gateway's suite moves a Mac between two local relays (§3.3): a phone follows,
  one that cannot hear yet is told once the new relay answers, one from before stays put, and the old
  relay forgets them. RealmKit's suite follows a `relay` in message 2, and keeps the pairing it moves.

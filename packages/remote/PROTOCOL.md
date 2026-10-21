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
   `{"v":1,"mac":"<Mac name>","server":"<Realm version>"}`.

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
  modelLabel?: string,    the model as the desktop's chip names it ("Opus 5.5"), or its default's name
  createdAt?: ms,         when the session was made
  effort?: string|null,   the reasoning level it was given, or null for the model's own
  permissionMode?: string,
                          how freely the agent acts ("default", "acceptEdits", "bypassPermissions"),
                          or the mode it is in instead ("plan", "ask"), as the desktop stores it
  activityAt?: ms         when the conversation last moved: a message went out, or the agent answered
                          or finished a turn
}
```

- `waiting` is the desktop's `waiting_permission`.
- `needsYou` is true exactly when the row is in `home.get`'s `needsYou`.
- **Lists are ordered by `activityAt`**, as the desktop's are, and a row's age is read from it.
  `updatedAt` moves whenever the Mac writes the row, for a change of settings or a rename as much as
  for a message, so a session set up again is not one that moved. A Mac before Plan 29 sends no
  `activityAt`; there `updatedAt` stands in.

A **transcript row** is one thing in a session's transcript. Every row has `key`, `seq` and `kind`,
then the fields its kind adds:

| `kind` | Fields |
|---|---|
| `user` | `text`, `attachments?: [{path, name, mime}]` |
| `assistant` | `text`, `streaming: bool` |
| `thinking` | `text` |
| `tool` | `name`, `summary`, `state: "running"\|"done"\|"error"`, `detail: string\|null` |
| `request` | `requestId`, `tool`, `title`, `summary`, `state: "pending"\|"allowed"\|"denied"`, `questions: [Question] \| null`, `asker?`, `message?`, `answers?`, `plan?: {text: string\|null, steps: [{text, status}] \| null}` |
| `plan` | `text: string\|null`, `steps: [{text, status}] \| null` |
| `notice` | `text`, `checkpointId?`, `files?: [{path, size}]` |
| `error` | `text`, `hint: string\|null` |
| `unknown` | `type`: the event type this phone cannot draw |

- **A key names a row.** Keys look like `u:<seq>`, `m:<messageId>`, `k:<messageId>`,
  `t:<toolUseId>`, `r:<requestId>`, `p:<planId>`, `c:<checkpointId>` or `e:<seq>`.
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
| `session.open` | `{id, limit?: int = 200}` | `{session: SessionRow, rows: [Row], hasMore: bool, hint?: string\|null}` |
| `session.close` | `{id}` | `{ok: true}` |
| `session.send` | `{id, text, delivery?: "auto"\|"queue"\|"steer", attachments?: [Upload]}` | `{ok: true}` |
| `session.options` | `{id}` | `SessionOptions` |
| `session.configure` | `{id, model?: string\|null, effort?: string\|null, mode?: "build"\|"plan"\|"ask", permission?}` | `SessionOptions`, as they are now |
| `session.answer` | `{id, requestId, decision: "allow"\|"allow_always"\|"deny", answers?: {<question id>: <value> \| [<value>]}}` | `{ok: true}` |
| `session.stop` | `{id}` | `{ok: true}` |
| `session.seen` | `{id, seq}` | `{ok: true}`. It marks the session read up to `seq`, and never moves backwards. |
| `session.create` | `{spaceId, agent, text, model?, effort?, mode?, permission?, attachments?: [Upload]}` | `{id}` |
| `agents.list` | `{}` | `{agents: [AgentOptions], defaultAgent: string\|null, midTurn: "queue"\|"steer", attachments: Limits}` |
| `session.changes` | `{id, checkpointId}` | `{checkpointId, files: [{path, oldPath, status, additions, deletions}], totalFiles}` |
| `session.diff` | `{id, checkpointId, path, from?: int = 0}` | `{path, oldPath, status, binary, additions, deletions, lines: [string], from, next: int\|null, total, truncated, truncatedReason}` |
| `session.file` | `{id, path}` | `{path, name, size, mime, preview: {kind: "image", mime, data} \| {kind: "text", text, truncated} \| {kind: "none", reason}}` |
| `space.icon` | `{id}` | `{mime, data}`: base64 |
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

**A session's settings are the desktop's chips.** `session.options` answers with the session's agent,
as `AgentOptions`, and what it is on now:

```
SessionOptions {
  agent: AgentOptions,
  model: string|null,          the model it was given, or null for its agent's default
  modelLabel: string,          the model as the chip names it, its default's name while none is given
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

**Opening a session subscribes the channel to it.** From then until `session.close` or the end of
the channel, the Mac sends that session's `session.rows`, `session.status` and `session.hint` events.

**Answers are the desktop's shape.** `answers` maps a question's `id` (its `question` on a Phase 1
Mac) to an option's `value` or words of the person's own; a multi-select question's answer is a
list. The Mac holds them to the request's card, as it holds the desktop's. A Phase 1 phone's
`{<question>: <label>}` is still accepted.

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
- **`session.file`**: a preview of one file that session's `files_made` listed, or that one of its
  `user_message`s was sent with, by the exact path listed, or a refusal (`FORBIDDEN`). A path that is
  now a link, or not a file, is refused, and so is a file that exists to hold a secret (a key, an
  `.env`), whatever sent it. Its `name` is its user row's: the name the person gave it. A picture is
  sent as a JPEG at most 1024 px on its longer side and 512 KB; a text as at most its first 16 KB;
  anything else as nothing but its name, size and type.
- **`session.send`** and **`session.create`**: they write a phone's files, and only into the Realm
  home's `tmp/attachments`, under names the Mac makes. A folder there that is a link elsewhere is not
  written through. The phone names no path.
- **`session.options`**, **`session.configure`** and **`agents.list`**: the agents, models, levels,
  modes and rungs the desktop's pickers offer, and what three settings decide for a phone: what a
  message typed mid-turn does (`sessions.midTurnMode`), the rung Build goes back to
  (`sessions.defaultPermissionMode`) and the agent a new session starts on (`ui.lastAgentKind`).
- **`space.icon`**: the picture a person uploaded or had made for a space, at most 256 KB.
- **`session.hint`** and `hint`: the suggested next message the desktop's prompter shows.

No call or event carries a terminal's output, a file outside those rules, another session's stream,
any other setting, or a key.

### Events

| Event | Payload | Meaning |
|---|---|---|
| `session.rows` | `{id, rows: [Row]}` | Rows to upsert by key. Text deltas are coalesced to at most ten a second. |
| `session.status` | `{id, status}` | The session's status changed. |
| `session.hint` | `{id, text: string\|null}` | The suggested next message changed: a newer one after a turn, or none once something was sent. |
| `home.changed` | `{}` | Call `home.get` again. Sent at most once a second. |
| `pair.result` | see §4.1 | Pairing channels only. |

### Error codes

`METHOD_NOT_FOUND`, `INVALID_PARAMS`, `NOT_FOUND`, `FORBIDDEN`, `SESSION_NOT_LIVE`, `INTERNAL`.

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
  send for one question. The server's suite fails when the committed file is not what the code
  produces, when a row kind has no example in it, or when a call that answers more than `{ok: true}`
  has none; RealmKit decodes every answer in it.
- **The relay.** Its own tests drive §3 against the Worker in workerd.

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

## 8. mobile.v1: the Phase 1 subset

All times are Unix milliseconds. A field marked `?` may be absent. A reader must ignore fields it
does not know, so the Mac can add fields without breaking an older phone.

### Rows

A **session row** is one session in a list:

```
SessionRow {
  id, title, spaceId, spaceName, agent,
  model: string|null,
  status: "idle"|"running"|"waiting"|"error"|"ended",
  needsYou: bool,
  unread: bool,
  updatedAt: ms
}
```

`waiting` is the desktop's `waiting_permission`.

A **transcript row** is one thing in a session's transcript. Every row has `key`, `seq` and `kind`,
then the fields its kind adds:

| `kind` | Fields |
|---|---|
| `user` | `text` |
| `assistant` | `text`, `streaming: bool` |
| `thinking` | `text` |
| `tool` | `name`, `summary`, `state: "running"\|"done"\|"error"`, `detail: string\|null` |
| `request` | `requestId`, `tool`, `title`, `summary`, `state: "pending"\|"allowed"\|"denied"`, `questions: [{question, header, multiSelect, options: [{label, description?}]}] \| null` |
| `plan` | `text: string\|null`, `steps: [{text, status}] \| null` |
| `notice` | `text` |
| `error` | `text`, `hint: string\|null` |
| `unknown` | `type`: the event type this phone cannot draw |

- **A key names a row.** Keys look like `u:<seq>`, `m:<messageId>`, `k:<messageId>`,
  `t:<toolUseId>`, `r:<requestId>`, `p:<planId>` or `e:<seq>`.
- **A later row with the same key replaces the earlier one** where it stands. That is how streamed
  text, tool results and answered requests update in place.
- **`seq`** is the server's sequence number of the event that made the row. Streamed rows carry the
  seq of the last persisted event before them.

### Calls

| Method | Params | Result |
|---|---|---|
| `ping` | `{}` | `{at: ms}`, the Mac's clock |
| `home.get` | `{}` | `{mac: {name}, needsYou: [SessionRow], spaces: [{id, name, icon, color, sessions: [SessionRow], more: int}]}` |
| `session.open` | `{id, limit?: int = 200}` | `{session: SessionRow, rows: [Row], hasMore: bool}` |
| `session.close` | `{id}` | `{ok: true}` |
| `session.send` | `{id, text, delivery?: "auto"\|"queue"\|"steer"}` | `{ok: true}` |
| `session.answer` | `{id, requestId, decision: "allow"\|"allow_always"\|"deny", answers?: {<question>: <label>}}` | `{ok: true}` |
| `session.stop` | `{id}` | `{ok: true}` |
| `session.create` | `{spaceId, agent, text}` | `{id}` |
| `debug.report` | `{name, data}` | `{ok: true}` |

**Opening a session subscribes the channel to it.** From then until `session.close` or the end of
the channel, the Mac sends that session's `session.rows` and `session.status` events.

`debug.report` exists only in development builds. The Mac writes it to `<home>/remote/reports/`.
Phase 1 uses it to bring the phone's measurements back.

### Events

| Event | Payload | Meaning |
|---|---|---|
| `session.rows` | `{id, rows: [Row]}` | Rows to upsert by key. Text deltas are coalesced to at most ten a second. |
| `session.status` | `{id, status}` | The session's status changed. |
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
- **The relay.** Its own tests drive §3 against the Worker in workerd.

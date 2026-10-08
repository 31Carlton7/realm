# Realm Plan 28 — Realm on your iPhone

> Numbered 28: 27 (the sidebar) is the highest on any branch. Renumber on landing if it collides.

> **Status (2026-10-08): Phase 1 is done; Phase 2 is under way on `feat/mobile`.** The four decisions
> below were answered by the owner on 2026-10-04. The pipe is built and measured end to end, through a
> deployed relay and on the owner's iPhone. Pushes decrypt on the device. "Phase 1 results" under
> Phases has the numbers and what Phase 2 inherits; "Phase 2 so far" has what has landed since.

## What it is for

One job: **leave the Mac while agents work, and still be the person they wait on.** See what every
session is doing, answer what it is blocked on, and send the next message or start new work from
the phone.

Two rules follow, and most of what is below comes from one of them.

1. **The Mac is the computer; the phone is a window onto it.** Agents, files, sign-ins and history
   stay on the Mac. The phone shows them and sends answers back. Nothing runs on the phone, and
   nothing runs on a server.
2. **Nothing readable leaves the two devices.** The relay that joins them forwards ciphertext it
   cannot open or forge, and keeps no account, password or transcript. Apple's push service carries
   ciphertext too.

## Decisions (answered 2026-10-04)

1. **A companion to the Mac, not a second Realm.** The phone shows and steers the Mac's sessions and
   runs no agent of its own.
2. **An encrypted Realm relay.** Not Tailscale, and not a port opened on the Mac. It works on any
   network with nothing else to install, and it is the only route that can deliver a push while the
   app is closed. This replaces the v1 spec's "relay via Tailscale first"
   (`docs/superpowers/specs/2026-08-17-realm-v1-design.md:273`) and answers the questions Plan 16
   left for the owner under "Mobile pairing (design-gated)"
   (`2026-09-01-plan-16-search-and-forks.md:14-17`).
3. **Native SwiftUI.** Push extensions, Live Activities, widgets, Face ID, the share sheet and the
   keychain are first-class in Swift. The app is small enough that one platform in its own language
   costs less than a cross-platform layer.
4. **TestFlight first, for the owner.** Internal testing until Phase 3 has been lived with. The App
   Store is Phase 4.

## What is there today

The facts from the code (`release/v1.6.0`, d0a33a58):

- **The server is already the only door.** The renderer talks only to realm-server over a WebSocket.
  That is the v1 spec's hard rule (line 82), kept "so a mobile client is a later client". `RpcServer`
  (`apps/server/src/rpc/server.ts:57`) listens on 127.0.0.1 and accepts a socket only if it offers
  the `realm.<token>` subprotocol. The port and token are in `<home>/daemon.json`, mode 0600.
- **It has no seam for a second kind of client.**
  - A handler's context is only `{ client: WebSocket }`: no principal.
  - There is no in-process `call()`.
  - `broadcast` sends every event to every socket, terminal output and text deltas included
    (`server.ts:97-100`).
  - Calling services directly skips the handlers' own logic: validation, broadcasts and
    `refuseWhileDraining`.
- **A relay beyond the Mac exists, in plain text.** `NotificationRelay`
  (`apps/server/src/notifications/relay.ts:63`) sends three moments to iMessage or a Slack webhook:
  a permission waiting, a session that finished or failed, and a blocked run (`RELAYED_CATEGORIES`,
  `packages/contracts/src/notifications.ts:89`). Notifications already dedupe on
  `(category, refId)`, so design.md's "one open condition is sent once" is already true. The phone's
  push is a third transport for the same moments, encrypted.
- **The event model is enough to drive a phone.**
  - There are 22 event kinds (`session-events.ts:305`). The 19 persisted ones carry a global,
    increasing `seq`.
  - History comes from `sessions.events {id, afterSeq, limit}`.
  - Questions and plan approvals are `permission_request`s (`AskUserQuestion`, `ExitPlanMode`), and
    all of them are answered by `sessions.respondPermission`.
- **What a phone needs to show is in the renderer, not the server.** All of these are renderer code:
  - "Needs you" (`components/sidebar/model.ts:263-305`);
  - the tool summaries (`panes/session/tool-summary.ts`, `rich/tool-view.ts`);
  - the transcript fold (`transcript-model.ts`);
  - the switch to Build mode after a plan is approved (`state/store.ts:5261-5274`).

  No RPC lists pending requests. Attachments are paths on the Mac; there is no upload.
- **The Mac's secrets live in Electron main.** The server cannot reach the Keychain. Main hands it
  one key per domain over the host bridge (`oauthKey`, `machineKey`, `eggsKey`;
  `browsers/host-bridge.ts:24-30`). A daemon that restarts with no Electron attached has none.
- **Keeping the Mac awake is a setting, off by default.** `power.preventSleep` holds
  `prevent-app-suspension` while a session is *working* (`apps/desktop/src/main/sleep-guard.ts`). A
  session waiting on you does not keep the Mac awake, and a headless daemon keeps nothing awake.
- **Realm can already drive an iOS Simulator and a cabled iPhone.** That is this app's test bench.
- **Nothing remote exists:** no pairing, device keys, push, relay service or iOS code.
- **What this Mac has:**
  - Xcode 27.0 beta 6, signed in to team FY9QB79VAP;
  - XcodeGen 2.44.1;
  - an Apple Distribution certificate;
  - a Cloudflare account (a `cloudflared` certificate in `~/.cloudflared`).

## How it fits together

```
  iPhone                              Cloudflare                          Mac
 ┌────────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
 │ Realm (SwiftUI)    │  wss   │ Worker                │  wss   │ realm-server             │
 │  RealmKit: Noise,  │◀──────▶│  one Durable Object   │◀──────▶│  remote/: link, Noise,   │
 │  relay, mobile API │ cipher │  per Mac: routes      │ cipher │  mobile API → the same   │
 │ Notification       │  text  │  frames, sends pushes │  text  │  RPC handlers the        │
 │  Service Extension │◀─APNs──│                       │ (Mac   │  desktop uses            │
 └────────────────────┘        └───────────────────────┘ dials) └──────────────────────────┘
```

- **The Mac dials out.** realm-server keeps one outbound WebSocket to the relay. Nothing listens on
  the Mac's network, so it works behind any router, VPN or hotel Wi-Fi.
- **The relay is one Durable Object per Mac.** It joins that Mac's socket to its phones' sockets and
  sends their pushes. Idle sockets hibernate and cost nothing.
- **The phone and the Mac authenticate each other end to end** (Noise, below). The relay carries
  frames it cannot read, alter or replay.

## The protocol

### Keys

Every Mac and every phone has two long-lived key pairs:

- **X25519**, for Noise: encryption, and proof of identity to the other end.
- **Ed25519**, for the relay: proof of which Mac or phone is connecting, and nothing more.

A Mac's address at the relay, `macId`, is the hash of its Ed25519 public key. So the relay needs no
sign-up and stores no secret: a Mac proves it owns `macId` by signing the relay's challenge. Phones
work the same way, and the relay accepts only phones their Mac has added.

Where the keys live:

- **Mac:** sealed under a new secret-box domain (`remote: 6` in
  `packages/contracts/src/secret-box.ts`). Electron main mints its key in the keyring and hands it
  over the host bridge, by the same path as `machineKey`.
- **Phone:** in the keychain as `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, in an access
  group shared with the Notification Service Extension. They are device-only, so they never go into a
  backup or iCloud Keychain.

**Not in the Secure Enclave.** It holds only P-256 keys, and the push extension has to decrypt with
the same key as the app. A stolen phone is answered by Remove on the Mac. cmux built the same thing
for its terminal (a Mac app, an iPhone companion, encrypted push) and made the same choice
([cmux#12384](https://github.com/manaflow-ai/cmux/pull/12384)).

### Ciphers, chosen by measurement

The protocol is Noise, the framework WireGuard is built on, with **25519, AES-GCM and SHA-256**:

| Pattern | Used for | Why this one |
|---|---|---|
| `Noise_IKpsk1_25519_AESGCM_SHA256` | pairing | The phone knows the Mac's key from the QR code. The code's one-time secret is the pre-shared key, checked in the phone's first message before the Mac answers. |
| `Noise_IK_25519_AESGCM_SHA256` | every connection after pairing | One round trip, both ends authenticated, forward secrecy from fresh ephemeral keys. |
| `Noise_K_25519_AESGCM_SHA256` | pushes to a closed app; messages left for a sleeping Mac | One-way, with both keys known in advance, so it needs no round trip. Each carries an id and a time, and the receiver drops repeats. |

**AES-GCM, not ChaCha20-Poly1305, because realm-server runs on Electron's Node**
(`server-process.ts:85-90`, `ELECTRON_RUN_AS_NODE`), and its BoringSSL has no ChaCha20-Poly1305.
Measured on Electron 37.10.3 (Node 22.21.1):

- `createCipheriv("chacha20-poly1305")` throws "Unknown cipher";
- AES-256-GCM, X25519, Ed25519 and HKDF all work.

Plain Node 22 has both, so the test suite alone would never have caught this. CryptoKit has AES-GCM,
Curve25519 and HKDF natively, and Workers verify Ed25519 in WebCrypto, so no side needs third-party
crypto.

Both implementations (TypeScript in `packages/remote`, Swift in `RealmKit`) are checked three ways:

- they pass the published Noise test vectors (cacophony, snow) for the three patterns;
- each opens the other's output, through a shared fixture file;
- the TypeScript one also runs under Electron's Node in a live check.

### Pairing

1. **Settings ▸ Devices ▸ Pair an iPhone.** The Mac opens a pairing window at the relay (5 minutes,
   5 attempts) and shows a QR code for `https://realm.computer/pair#<payload>`. The payload holds:
   - the relay URL and `macId`;
   - the Mac's two public keys;
   - a 32-byte one-time secret;
   - the Mac's name and the expiry.
2. **The phone scans it,** in the app or with the Camera. The link is a Universal Link, and the
   payload sits after the `#`, so a browser that opens it instead never sends it to the website.
3. **The phone runs IKpsk1 through the relay.** The Mac learns the phone's keys, name and model.
4. **The Mac asks.** "Pair Carlton's iPhone? It can read every session on this Mac and answer for
   you." Pair / Cancel. Meanwhile the phone shows "Confirm on your Mac."
5. **On Pair,** the Mac tells the relay to accept the phone's key and writes the device row.

Remove on the Mac revokes the phone at the relay and drops its channel at once. Pairing again
replaces the old keys.

### Every connection

1. The phone signs the relay's challenge and opens a channel to its Mac.
2. It runs IK, one round trip.
3. From then on it speaks the mobile API in AES-GCM frames.

The Noise prologue binds the protocol version, `macId` and `phoneId`, so a frame cannot be replayed
into another pair. A message larger than a Noise frame's 65,535 bytes is split. Transcripts load in
pages, so that seldom happens.

### Pushes, and answers from a notification

- **The Mac seals the moment.** When something the person must come back for happens (see "When the
  phone buzzes"), the Mac seals a small JSON to each phone with Noise K: kind, session title, one
  line, ids and time. It hands the relay that ciphertext plus routing: which phone, time-sensitive or
  not, a hashed collapse id, and the badge count.
- **The extension opens it.** The relay sends an APNs alert whose visible text is a placeholder
  ("Something on your Mac needs you"), with `mutable-content` set. The Notification Service Extension
  opens it and rewrites the title, body, thread and actions. If it cannot, the placeholder stays.
  There is no plaintext fallback.
- **Answers go over a real channel.** Allow, Deny and Reply on a notification open a normal channel
  from the background and send the answer. If the Mac is asleep, the phone says so in a follow-up
  notification instead of claiming it went.
- **cmux's lesson** ([cmux#14039](https://github.com/manaflow-ai/cmux/pull/14039)): their pushes
  showed only the placeholder on every release build. The extension's state lived in an App Group,
  and the release App IDs lacked one. So everything this extension needs lives in the shared keychain
  group, and decryption is checked on a TestFlight build, not only on a debug one.

### What the relay can see

- **Sees:**
  - which Mac and phones are connected, and when;
  - frame sizes and timing;
  - APNs device tokens;
  - each push's urgency and badge count.
- **Never sees:** a session, a title, a message, a file, or a key that opens any of them. It cannot
  forge or replay a frame.
- **Stores:**
  - each Mac's public keys;
  - its phones' public keys and push tokens;
  - last-seen times;
  - from Phase 3, messages typed while the Mac is asleep, as ciphertext, for at most 24 hours.

## The phone speaks a mobile API, not Realm's RPC

The desktop's RPC has 202 methods, and the v2 work is changing them now. The phone gets its own
small, versioned API, `mobile.v1`, served by the gateway on the Mac.

- **It is the allowlist by construction.** A call the phone has no reason to make does not exist. It
  is not filtered out of a list that keeps growing.
- **It goes through the same handlers.** Each call runs desktop RPC methods in process through a new
  `RpcServer.call()`, under a `phone:<id>` principal. That gives it the same zod parse, the same
  handler logic and the same broadcasts as the desktop.
- **It answers in rows a phone can draw.** A session row comes with its status and one line. Each
  message, tool call, request or notice is one transcript row, with its summary already written by
  the code the desktop uses. Swift draws the rows; it does not re-implement the renderer.
- **It is versioned.** An older phone keeps working against a newer Mac. A Mac too old for the phone
  says "Update Realm on your Mac".

| Call | What it does | Built on |
|---|---|---|
| `home.get` | Needs you across every profile, then each space's sessions by activity | `spaces.list`, `sessions.listAll`, the sidebar's `needsYou()` |
| `space.sessions` | One space's sessions, paged | `sessions.list` |
| `session.open`, `session.close` | The last page of rows, pending requests, queued messages and the suggested reply; live rows while it is open | `sessions.get`, `sessions.events`, `sessions.queued` |
| `session.send` | A message, with photos; queued, steered or sent | `sessions.send`. Photos are written to `<home>/tmp/attachments`, where pasted files go, under the 20 MB cap. |
| `session.answer` | Allow, Allow always, Deny, a question's answers, a plan's approval | `sessions.respondPermission`, then Build mode after a plan, as the desktop does |
| `session.stop` | Stops the turn | `sessions.interrupt` |
| `session.dequeue` | Takes back a queued message | `sessions.dequeue` |
| `session.seen` | Marks read up to a row | `sessions.markSeen` |
| `session.create` | A new session in a space, with its first message | `sessions.create` + `sessions.send` |
| `session.options` | Model, effort, permission mode (never full access) | `sessions.setOptions` |
| `catalog.get` | The agents that are ready, their models, and the modes a phone may pick | `agents.probe`, `models.catalog` |
| `usage.get` | Plan limits and this month's spend (Phase 4) | `limits.get`, `usage.summary` |

Events:

- `home.changed`, as row patches;
- `session.rows`, rows appended or replaced in open sessions, with text deltas coalesced to ten a
  second;
- `session.status`;
- `session.queue`.

Nothing else crosses: never `terminal.data`, and never another session's stream.

**What the phone cannot do, by design:**

- open or type in a terminal;
- read or edit files;
- drive a browser;
- see or fill sign-ins;
- change settings, connections, skills or memory;
- delete anything;
- switch on full access.

Each is a reason to walk back to the Mac, and each would widen what a lost phone could do.

## The Mac side

New code, in `apps/server/src/remote/`:

- `keys.ts`: the Mac's two key pairs, sealed under the `remote` domain.
- `link.ts`: the one outbound WebSocket, using `ws` as `machines/dial.ts` already does.
  - It signs the relay's challenge and sends a heartbeat every 20 s.
  - It reconnects with backoff and jitter.
  - It reports its state to Settings: Connected, Connecting, or Can't reach the relay.
- `pairing.ts`: the window, the QR payload, the IKpsk1 responder, the owner's confirmation and the
  device rows.
- `channel.ts`: a Noise IK responder and transport for each phone.
- `api.ts` and `rows.ts`: `mobile.v1`, and the projection from events to rows. `rows.ts` switches
  over every event kind with a `never` default, so a kind added to `SessionEventSchema` fails
  typecheck until the phone has a row for it.
- `push.ts`: the phone transport for `NotificationRelay`. It seals a push for each phone, hands it to
  the link, and holds it back while the owner is at the Mac.
- A migration adding `remote_devices` (id, name, model, keys, added, last seen, revoked). It is
  append-only and tested against a hand-written fixture of the previous schema.

Small changes to existing files. These are the only places this work meets anyone else's:

| File | Change |
|---|---|
| `apps/server/src/rpc/server.ts` | `call(method, params, ctx)` in process, `onBroadcast(listener)`, and a principal in the handler context |
| `apps/server/src/app.ts` | Construct, start and close the remote service: about ten lines near `:825`, `:1064` and `:1097` |
| `apps/server/src/notifications/relay.ts` | A third transport, `phone` |
| `packages/contracts/src/rpc.ts`, `secret-box.ts` | `remote.*` methods and events for Settings, and the `remote` secret domain |
| `apps/desktop/src/main/secret-store.ts`, `index.ts`; `browsers/host-bridge.ts`; `rpc/methods.ts:826-843` | Mint and hand over the `remote` key, like `machineKey` |
| `apps/desktop/src/main/index.ts`, `sleep-guard.ts` | Tell the server when the Mac is idle or locked, and keep it awake while a session waits on a paired phone |
| `settings-index.ts`, `SettingsPage.tsx` | A Devices page, and an iPhone row beside iMessage and Slack on Notifications |
| Renderer → `packages/view` (new) | Move `needsYou()`, `toolSummary()`, `toolInputView()` and the transcript fold out of the renderer unchanged, so the desktop and the phone's rows share one implementation |

### On the Mac: Settings ▸ Devices

- **The page is headed Devices.** Its one action is Pair an iPhone, which opens a sheet with the QR
  code, the time left, and "Open Realm on your iPhone and scan this."
- **Each paired phone is a row:** name, model, and "Last seen 4 min ago", with Remove. Remove asks
  first: "Remove Carlton's iPhone? It will no longer see or answer sessions on this Mac."
- **The relay's state appears only when something is wrong:** "Can't reach the relay. Your phone
  shows this Mac as offline."
- **One line about sleep:** "While this Mac sleeps, your phone cannot reach it." It links to
  General ▸ Power. With a phone paired, Keep the Mac awake there also holds while a session waits on
  you.
- **Notifications gets an iPhone row** beside iMessage and Slack. It covers the same three moments,
  is on by default once a phone is paired, and is drawn only then.

### When the phone buzzes

**What buzzes:** the same three moments the iMessage relay sends, each once.

- a permission or question waiting;
- a session finished or failed;
- a run blocked.

**When it buzzes:** not while you are at the Mac.

- Push at once if the screen is locked, the Mac has been idle two minutes, or no Realm window is
  open.
- Otherwise wait two minutes, and push only if it is still waiting.

Main reports idle and lock state to the server. A headless daemon counts as away.

## The relay

`services/relay/` is a Cloudflare Worker with one Durable Object class, `MacRoom`, keyed by `macId`
and backed by SQLite storage.

- **Routes:**
  - `/v1/mac/:macId`, for the Mac;
  - `/v1/phone/:macId`, for a paired phone;
  - `/v1/pair/:macId`, for a phone that is pairing, accepted only while the Mac holds a window open;
  - `/health`.

  Each WebSocket opens with a challenge, signed by the connecting key.
- **Frames:** a type byte and a channel id in front of opaque bytes. The relay routes frames and
  never parses past the header.
- **Hibernation:**
  - Sockets are accepted with `acceptWebSocket`.
  - `setWebSocketAutoResponse` answers the heartbeat without waking the object.
  - `getWebSocketAutoResponseTimestamp` gives the Mac's last ping. That is how a phone learns
    "Asleep since 10:42".
- **Pushes:** APNs over HTTP/2, with a token signed ES256 in WebCrypto and cached for 50 minutes. The
  `.p8` key is a Worker secret. Deployed Workers reach APNs over HTTP/2, but `wrangler dev` on macOS
  does not ([workerd#4841](https://github.com/cloudflare/workerd/issues/4841)). So local tests point
  APNs at a fake, and the real push check runs against a staging Worker.
- **Limits:** frames and pushes per Mac per minute, a 1 MiB frame cap, and attempts per pairing
  window.
- **Deploy:** `wrangler deploy` from `services/relay`, by CLI, the way the site deploys. There are
  two environments, `staging` and `production`.
- **Cost:** the Workers Free plan covers one owner. Hibernated sockets are free, and incoming
  messages are billed at 20 to a request.
- **Domain:** realm.computer's DNS is on Vercel, and a Worker's custom domain needs its zone on
  Cloudflare. Phases 1–3 use the `workers.dev` hostname. The relay URL is part of each pairing, so
  the domain gets decided before anyone but the owner pairs.

## The iPhone app

### What it shows

- **Home is the sidebar's answer to "what should I look at".** It is one list:
  - Needs you comes first: sessions waiting on a permission or a question, then sessions that failed
    and are unread.
  - Then each space is a section, its sessions by activity, five and then Show more.
  - Pull to refresh.

  Each row shows the title, the space, the agent and model, the status as a word and a glyph (never
  colour alone), and how long ago it moved. Under the title sit the Mac and its state: "MacBook Pro
  · Asleep since 10:42".
- **A session is its transcript and the composer.**
  - The transcript holds your messages and the agent's prose as Markdown.
  - A tool call is one line that opens to its detail. Thinking is folded.
  - A permission, question or plan card is answered in place. Errors come with their fix.
  - The composer is pinned below, with the agent and model beside it, and Stop while the session
    runs. The suggested next message (`prompt_hint`) sits above the field.
  - A message sent mid-turn is queued or steers, as the Mac's setting says. It shows as queued until
    it goes.
- **New session:** space, agent, model, mode (never full access), message and photos.
- **Settings:** paired Macs, notifications, Face ID, and about.
- **Nothing is blank.** A row this version cannot draw yet says "Open this on your Mac".

### How it looks

design.md, carried to a phone:

- **The platform's, not ornamental.**
  - Navigation, lists, sheets, menus and swipe actions are the system's.
  - System chrome wears the system's material (Liquid Glass on iOS 26 and later). That is platform
    material, for the same reason the Mac window's translucency is.
  - Realm's own surfaces stay solid.
- **The same palette.** The authored dark and light tokens (`page`, `canvas`, `surface`, `inset`, the
  three inks, the accent, the state colours) are generated into an asset catalog from
  `packages/ui/src/themes.ts`. A script with a test does it, so the phone cannot drift from the Mac.
- **The same type.** Inter and JetBrains Mono, on the same ladder, scaled with Dynamic Type. They are
  bundled as TTF, because the desktop ships WOFF2 and iOS cannot load it. The transcript reads at
  the system's body size, not the desktop's 15: a phone in the hand is not a screen at arm's length.
- **The same rules.**
  - Touch targets are at least 44 points.
  - Status is shown in words, not by colour alone.
  - The accent marks focus, selection and the one primary action.
  - Mono is only for code, paths, models and commands.
  - No decorative motion; Reduce Motion and Reduce Transparency are honoured.
- **A dismissal is never an answer.** Swiping a request sheet away leaves the request waiting. That is
  the phone's form of "Escape is a way out, so it must never also be an answer".
- **Say what happened.**
  - A message reads Sent only once the Mac has it.
  - An answer confirms with a light haptic when the Mac accepts it, not when the button is pressed.
  - When the Mac sleeps: "Your Mac is asleep. This sends when it wakes."
- **Icons:**
  - SF Symbols for system chrome, weighted to the text.
  - Realm's own marks for agents.
  - The spaces' own icons: emoji and pictures as they are, and Hugeicons glyphs from the SVG the Mac
    sends.

### Code

```
apps/ios/
  project.yml                   XcodeGen: targets, entitlements, Info.plist
  RealmKit/                     Swift package: everything testable without a simulator
    Sources/RealmKit/
      Noise/                    IK, IKpsk1 and K on CryptoKit
      Relay/                    the WebSocket, challenge, frames, reconnect
      API/                      mobile.v1 models and client
      Store/                    observable state; on-disk cache with complete file protection
      Keys/                     device-only keychain, shared access group
    Tests/RealmKitTests/        Noise vectors, cross-implementation fixtures, every API fixture
  Realm/                        the app: SwiftUI screens, scanner, notification actions
  RealmNotificationService/     opens pushes; links only RealmKit's Noise and Keys, under 24 MB
  RealmUITests/                 XCUITest against a scratch Mac and a local relay
  scripts/                      tokens to asset catalog, fixtures, archive and upload
```

- **Identifiers.** The bundle is `co.charmtechnologies.realm.ios`, beside the Mac app's
  `co.charmtechnologies.realm`. The extension sits under it, and both share the keychain group.
- **Platform.** iOS 26 and later, Swift 6. The `.xcodeproj` is generated and not committed.
- **Markdown.** Apple's `swift-markdown` (cmark-gfm), with a renderer for the blocks transcripts use.
  No web view.
- **Contracts.** The `mobile.v1` schemas are zod, in `packages/remote`.
  - A script writes a fixture for every call, event and row kind, from real projections.
  - Swift decodes every fixture in its tests.
  - A TypeScript test fails when a row kind has no fixture.

  There is no code generation: a mismatch is a failing test on one side or the other.

## Security

| Threat | Answer |
|---|---|
| The relay, or someone who breaks into it | Sees only the metadata above. It cannot read, forge or replay anything, because keys are pinned at pairing. |
| Someone who photographs the QR code | Has five minutes, and the owner still has to click Pair on the Mac. |
| A lost or stolen phone | Remove on the Mac revokes it at the relay and on the Mac at once. Keys are device-only, and the cache is unreadable while the phone is locked. Face ID to open the app is an option. |
| An answer that outlives the moment | Allow always asks for Face ID. Allow on a lock-screen notification needs the phone unlocked. Full access cannot be switched on from the phone. |
| A page an agent read, trying to reach the phone | Transcript text is drawn as text and Markdown: no HTML, no web view, no remote images. Links open in Safari only on a tap. |
| The relay used as a free pipe | Rate limits per Mac. App Attest for phones before external testers. |

Every action from the phone is recorded where the desktop shows it: "Sent from Carlton's iPhone" on
a message, "Allowed from Carlton's iPhone" on a request.

## Phases

Each phase ships on its own.

### Phase 1 — The pipe (spike)

Prove the hard part before building screens.

**What it shows.** Two clients pair with a scratch Mac (a scratch `REALM_HOME` and the fake engine):

- a TypeScript test phone;
- a bare SwiftUI shell, on the Simulator and on the owner's iPhone.

Each lists sessions, opens one, and watches rows arrive while it runs. Separately, one push sealed on
the Mac is opened by the extension on the iPhone.

**What gets built:**

- `packages/remote`: Noise, frames and the `mobile.v1` schemas;
- `services/relay`, run locally and as a staging Worker;
- `apps/server/src/remote/`, behind a development flag;
- `RpcServer.call()` and `onBroadcast()`;
- `RealmKit` and a one-screen app.

**What is measured** and written into this plan before Phase 2:

- handshake time;
- request round trip, p50 and p95 (phone → relay → Mac → phone), on Wi-Fi and on LTE;
- event latency, p50 and p95 (server emit → phone draw);
- resume after foregrounding, to the first fresh row;
- an answer from a notification, from tap to Mac;
- how fast the phone learns the Mac went offline, by sleep and by a pulled network;
- Durable Object CPU per thousand frames.

**It passes if:**

- the relay's test harness never sees a planted marker string in any frame;
- round trip p95 is ≤ 250 ms on Wi-Fi and ≤ 500 ms on LTE;
- event latency p95 is ≤ 300 ms on Wi-Fi;
- resume takes ≤ 1.5 s;
- the push opens on the device.

### Phase 1 results (finished 2026-10-08)

**Built,** on `feat/mobile-phase-1`:

- **`packages/remote`:** Noise, frames, pairing links, the `mobile.v1` schemas, and the contract,
  `PROTOCOL.md`.
- **`services/relay`:** the Worker, its Durable Object, and a local host running the same core.
- **`apps/server/src/remote`:** the gateway, dialling the server over loopback. No existing server
  file changed.
- **`apps/ios`:**
  - RealmKit;
  - a one-screen app: pair, Home, a session with its requests and questions, diagnostics;
  - the Notification Service Extension.

**Checked:**

- **The published Noise vectors.** All five pass byte for byte in TypeScript, in Swift, and inside
  Electron 37.10.3 itself (`mobile-crypto-electron-live.ts`). Each side also opens the other's
  fixtures.
- **The test suites:**
  - relay: 137 tests, 50 of them contract cases run against both hosts;
  - RealmKit: 89 tests;
  - gateway and rows: 15 tests;
  - protocol: 24 tests.
- **Mutation testing.** Ten mutants of the Mac side, all caught, including:
  - the nonce byte order;
  - the prologue;
  - the psk;
  - the IK static-key check;
  - unopened sessions' rows;
  - unknown calls;
  - a revoke the relay is not told about.

  The relay and Swift helpers mutated their own code the same way.
- **The marker test** (`mobile-pipe-live.ts`). A marker typed into a session reached the phone
  decrypted. A tap in front of the relay's real Worker saw 739 frames and never the marker.
- **The real app in the Simulator** (`mobile-sim-live.ts`). It paired from a link through the Worker,
  opened a session and reported its own timings.

**What the phone may not do, proved through the real server:**

- a wrong pairing secret is refused before the owner is asked;
- a declined pairing is refused;
- a call outside `mobile.v1` is refused;
- a removed phone is refused by the relay itself (4403);
- a phone whose relay key is paired but whose Noise key is not is refused by the Mac.

**Local numbers.** These are loopback timings: they show the code's own cost, not the network's.

| Measure | TypeScript phone, `wrangler dev` | The app in the Simulator |
|---|---|---|
| Handshake | 5.0 ms | 26.9 ms |
| Round trip | p50 0.6 ms, p95 1.1 ms | p50 1.8 ms, p95 5.8 ms |
| Event, server to phone | p50 0.64 ms, p95 0.76 ms | — |
| Send to own row | p50 28 ms | p50 14 ms, p95 56 ms |
| Open a session | 3.7 ms (40 rows) | first row 16 ms |
| Resume | 10 ms | — |
| Mac leaves, then returns, as seen by the phone | 0.7 ms, then 4 ms | — |

**Found while building:**

- **Request ids must be strings.** The desktop RPC rejects a numeric request id without a reply.
- **Listen before the socket opens.** A relay speaks the instant a socket opens, so a client must
  queue messages from the moment it creates the socket.
- **The Simulator skips the extension.** It delivers a `simctl push` without running the Notification
  Service Extension, so decryption on a device needs a real APNs push.
- **A Mac that goes quiet is not announced.** The relay tells phones when the Mac's socket closes. A
  Mac whose socket stays open but silent, as in sleep, is reported only in `ready` and `mac` messages.
  Measured below; Phase 2 fixes it.
- **Node's `ws` compresses by default, and Cloudflare accepts.** Every frame is ciphertext, which
  cannot compress, and each one queued for zlib on libuv's thread pool. Turning `permessage-deflate`
  off took event latency through the deployed relay from 299 ms to 32 ms at the median, and from
  1.6 s to 40 ms at p95. `PROTOCOL.md` §3 now forbids offering it.

**Real network.** The relay is deployed as `realm-relay-staging` on the owner's Cloudflare
(`workers.dev`), holding the APNs key as a secret. The Mac side is the gateway beside a built server on
a scratch home, using the fake agent. The phone side is the app on the owner's iPhone 17 Pro (iOS 27.2),
paired through that relay. The TypeScript phone ran on the Mac, so its numbers are the relay path
alone.

| Measure | TypeScript phone via Cloudflare (3 runs) | iPhone, cellular (3 runs) | iPhone, steady network (1 run) |
|---|---|---|---|
| Handshake | 272–316 ms | 157, 1,320, 4,673 ms | 101 ms |
| Connect, to ready | — | 334, 1,526, 4,903 ms | 347 ms |
| Round trip | p50 83–91 ms, p95 160–361 ms | p50 102–188 ms, p95 403–1,283 ms, spikes to 3.2 s | p50 75 ms, p95 169 ms |
| Event, server to phone | p50 32–39 ms, p95 39–122 ms | — | — |
| Send to own row | p50 85–92 ms | p50 119–235 ms, p95 141–1,308 ms | p50 149 ms (5 sends, one at 1.1 s) |
| Open a session | 76–95 ms (40 rows) | first row 141–960 ms | first row 204 ms |
| Resume | 358–406 ms | — | — |
| Mac quits, as the phone sees it | 36–47 ms | — | — |
| Mac back, as the phone sees it | 199–249 ms | — | — |

The last iPhone run looked like Wi-Fi: steady pings, only one of 50 over 300 ms. The app does not
report its network, so that label is the owner's to confirm.

**The push.** The Mac sealed it with Noise K and the relay sent it through the APNs sandbox. On the
iPhone, the Notification Service Extension opened it and showed "Fix the flaky test — Wants to run
`pnpm test`", on 2026-10-06 and again on 2026-10-08. Every hop between the two devices carried only
ciphertext and the placeholder.

**The relay's cost.** Cloudflare logs a relayed message at 0 ms of CPU, because it rounds to whole
milliseconds. Across 22 sampled messages the total was 1 ms, so about 0.05 ms each: under 50 ms of CPU
per thousand frames. A connection's setup and signature check cost about 1.1 ms. Hibernated sockets
cost nothing between messages.

**A quiet Mac** (`mobile-quiet-mac-live.ts`). The gateway was frozen with its socket open, which is
what the relay sees of a sleeping Mac or a pulled network.
- **The phone was never told,** not within 180 s.
- **A request** went unanswered for 15 s.
- **On waking,** the Mac was reachable again in 0.4 s.
- **A Mac that closes its socket** reaches the phone in about 40 ms.

**Against the pass marks:**

| Mark | Result |
|---|---|
| No planted marker crosses the relay in the clear | **Met.** Four runs through the real Worker, about 750 frames each. |
| Round trip p95 ≤ 250 ms on Wi-Fi | **Met** on the iPhone (169 ms) and in the last Mac run (160 ms). Missed in two Mac runs taken while this Mac was heavily loaded (253 and 361 ms). |
| Round trip p95 ≤ 500 ms on LTE | **Missed** in two of three runs (403, 699 and 1,283 ms). The spikes are the radio's, not the relay's: the same path from the Mac holds 160 ms. |
| Event latency p95 ≤ 300 ms on Wi-Fi | **Met** for the relay path (39 ms). The phone's send-to-row p95 rests on five samples, one an outlier: not enough to call. |
| Resume ≤ 1.5 s | **Met** on the Mac path (0.4 s) and on the iPhone when its radio was awake (0.35 s). **Missed** on a cold cellular radio (1.5 and 4.9 s). |
| A push opens on the device | **Met.** It decrypted on the iPhone, twice. |

**What Phase 2 inherits:**
1. **The relay announces a quiet Mac.** While any phone is connected, an alarm checks the Mac's last
   heartbeat (sent every 20 s) and tells phones `online:false` once it is more than about 60 s old. The
   Mac's next message clears it.
2. **Cellular is shown honestly, not chased.** A first connection on a cold radio can take seconds.
   The app says "Connecting…" and "Sending…" until the Mac answers, and never times out an answer the
   person gave. A shorter heartbeat while a session is open is worth one measured try, against its
   battery cost.
3. **Rebase onto the 2.0 line.** Realm 2.0 shipped on 2026-10-06 and `integration/v0.6` is now
   2.0.3, 488 commits past this branch's base. The only conflict is `pnpm-lock.yaml`, which is
   regenerated.
4. **Before TestFlight:** the released Xcode 27 (this Mac has 27.0 beta 6), and the App Store
   Connect app record for `co.charmtechnologies.realm.ios`.

### Phase 2 so far (2026-10-08)

- **Inherited 1, the quiet Mac: done, and live.** The relay's alarm now watches a connected Mac's
  silence while any phone is connected (PROTOCOL.md §3.2). Against the deployed relay, a SIGSTOPped
  sidecar was announced to its phone after **60.0 s** (Phase 1: not within 180 s). On SIGCONT the
  phone heard it was back after **34 ms**, and got its first answer after 0.5 s.
- **Inherited 3, the rebase: done.** `feat/mobile` sits on 2.0.3.
- **Inherited 4: answered by the owner.** Upload from Xcode 27.0 beta 6 and accept the ITMS-90534
  risk, rather than install the released Xcode now. The app record exists (see "What only the owner
  can do").
- **`pnpm ios:release`** is `scripts/ios-release.mjs`. It takes the next build number from App Store
  Connect, then runs XcodeGen and archives Release. It exports an App Store Connect IPA and refuses to
  upload it unless it is distribution-signed, with production push and the notification extension
  inside. `asc publish testflight` then uploads it with the API key and gives it to Internal Testers.
- **The Mac's half is merged into `feat/mobile`.**
  - **realm-server runs Realm Mobile itself.** It calls its own RPC in process, as a named principal.
    The Mac's identity is sealed under a new `remote` secret domain, whose key Electron main hands
    over. Phones are kept in `remote_devices` (migration v42).
  - **Pushes** are a third `NotificationRelay` transport, held back while the owner is at the Mac.
    Main reports whether they are.
  - **Live, the built server** pairs, opens a session, and pushes a question only the phone can open.
    It also cuts off a removed phone: 10/10 checks.
- **Settings ▸ Devices is merged.** It shows the QR sheet, asks the question in the same sheet, has
  Remove with a confirm, and adds a Notify my iPhone row.
  - Live against the real server half: 49/49 checks, dark and light.
  - Vision decodes the code off the window, and it is the server's own pairing link. The TypeScript
    phone pairs through a local relay.
- **Keep awake.** Main's guard now also holds for a waiting session while a phone is paired. With no
  app attached, the server holds `caffeinate -i -w <pid>` under the same rule.
- **Phase 1's pipe, re-measured after the merge, through the deployed relay:**
  - round trip p50 71 ms, p95 267 ms;
  - an event, one way, p50 33 ms;
  - "Mac back" 228 ms;
  - the quiet-Mac notice at 60.0 s, and the back-online notice in 28 ms.

### Phase 2 — Watch (the first TestFlight build)

**What gets built:**

- Pairing from Settings ▸ Devices, the device list and Remove. The Universal Link needs
  `apple-app-site-association` on realm.computer.
- Home, and the transcript with every row kind, live updates and the cache. The Mac-asleep and
  relay-unreachable states.
- Pushes for the three moments, held back while the owner is at the Mac. Tapping one opens the
  session.
- Keep awake holds while a session waits on a paired phone. Without Electron, the server holds its
  own `caffeinate -i`.
- `packages/view`: the shared helpers, moved out of the renderer.
- `pnpm ios:release`: archive, export and upload to TestFlight.

**It passes if:**

- the phone's Needs you matches the desktop's for the same scratch data (a live check compares the
  two);
- every event kind renders, or says "Open this on your Mac";
- Remove cuts a phone off within a second;
- a push decrypts on the TestFlight build.

### Phase 3 — Answer

**What gets built:**

- Reply, queue or steer; Stop; take back a queued message.
- Allow, Allow always (with Face ID) and Deny; questions, including multi-select, Other and secret;
  plan approval. All of these work in the app and from the notification.
- New session, with space, agent, model and mode. Photos from the library or the camera.
- Messages typed while the Mac sleeps wait at the relay (ciphertext, 24 hours) and send when it
  wakes. Answers to requests are never held, because a request belongs to a running agent.
- "Sent from …" in the desktop transcript.

**It passes if:**

- each action reaches the fake engine in a live check, and the phone shows the Mac's outcome;
- a request answered on the Mac first disappears from the phone;
- an answer to an expired request is refused, with the reason.

### Phase 4 — Reach (the App Store)

**What gets built:**

- **Live Activities for a running session.** The push's content state carries status and counts, and
  the title is set on the phone when the activity starts. The system applies content state without
  an extension, so it carries nothing readable — unless a test in this phase shows the widget can
  open a sealed field as it draws.
- **A widget** showing what waits.
- **App Intents and Siri:** "Ask Realm in …".
- **A share extension:** a link, text or photo into a new session.
- **Diffs and files; usage and plan limits.**
- **iPad:** a split view, with the same list as the sidebar.
- **What the App Store needs:** a privacy page on realm.computer, the App Privacy answers, export
  compliance, App Attest, and the relay's own domain.

### Later

- Apple Watch, to answer from the wrist.
- A direct path when the phone and Mac share a Wi-Fi network.
- View-only streams of a session's browser, simulator or terminal.
- Android.

## Testing

- **TypeScript, in the suite:**
  - Noise vectors and cross fixtures;
  - the pairing state machine;
  - `mobile.v1` against fake services, including that nothing outside the API answers and that
    `terminal.data` never crosses;
  - the projection's exhaustiveness;
  - push hold-back and dedup;
  - the migration against its fixture.
- **Relay,** with `@cloudflare/vitest-pool-workers` inside workerd:
  - challenge auth and routing;
  - pairing windows and revocation;
  - last-seen without waking;
  - limits;
  - the APNs request, against a fake.
- **Swift:** `swift test` for RealmKit (vectors, fixtures, frame splitting, reconnect against a fake
  transport), and XCUITest for the app.
- **Live checks.** Both use the fake engine only, because a real one bills the account.
  - `mobile-pipe-live.mjs` runs the built server on a scratch home, a local relay and the TypeScript
    test phone. It pairs, lists, streams and answers, and prints the latencies.
  - `mobile-sim-live.mjs` builds the app for the Simulator and runs XCUITest against the same setup.
- **On the owner's iPhone, before each TestFlight upload:** pair, decrypt a push on the release
  build, use a notification action, and check the Mac-asleep state.
- **Mutants that must fail a test:**
  - drop the psk check;
  - accept a phone the Mac never added;
  - skip the prologue binding;
  - answer a call outside `mobile.v1`;
  - forward `terminal.data`;
  - fall back to plaintext when a push will not open.
- **Gates for every mobile PR:** the existing three, plus `pnpm ios:test` and `pnpm relay:test`.

## What only the owner can do

Each is done once. Phase 1 needs only items 2, 4 and 5.

1. **Install the released Xcode 27.** This Mac has 27.0 beta 6. App Store Connect refuses builds from
   a beta Xcode unless Apple's release notes name that beta (ITMS-90534), and 27.0 shipped on
   2026-09-14. *2026-10-08: the owner chose to try the beta first.*
2. **An APNs key.** Create it at developer.apple.com ▸ Certificates, IDs & Profiles ▸ Keys, or name
   an existing `.p8`. It goes into the relay as a Worker secret and nowhere else.
3. **The app record in App Store Connect.** *Done 2026-10-08 with `asc web apps create`.* The listing
   is "Realm: Agent Workspace" because "Realm" belongs to another developer; the home screen still
   says Realm. App id 6820452196, SKU REALM-IOS. Its internal "Internal Testers" group gets every
   build, and the owner is in it.
4. **`wrangler login`, once,** in a terminal pane: the Cloudflare account authorises the relay's
   deploys.
5. **Developer Mode on the iPhone** (Settings ▸ Privacy & Security), for development builds over the
   cable.
6. **TestFlight on the iPhone,** from Phase 2.
7. **Later:** the relay's domain. *The export-compliance answer was given 2026-10-08:* built-in
   encryption only (all of it is CryptoKit), so `ITSAppUsesNonExemptEncryption` is NO.

## Working beside the v2 work

The v2 work could not be found: no branch, worktree or commit mentions it. Before Phase 1 writes to
existing files:

- **Which session and branch is it?** Phase 1 starts on `release/v1.6.0`, in new files only, and
  rebases onto the v2 line once that is known.
- **The overlap is the table under "The Mac side".** Everything else is in new directories:
  `apps/ios`, `services/relay`, `packages/remote`, `packages/view` and `apps/server/src/remote`.
- **The riskiest overlap is `packages/view`.** It moves renderer code (the sidebar's `needsYou`, tool
  summaries, the transcript fold) that a UI-heavy v2 is likely editing. It moves unchanged, in one
  commit, at a moment agreed with the v2 agent.
- **The mobile API is the buffer.** When v2 changes events or methods, only `rows.ts` and `api.ts`
  follow, and the exhaustiveness check says where.

## Risks

- **A sleeping Mac is unreachable,** under any design that keeps the work on it. The phone says so,
  with the time the Mac was last seen. Keep awake holds while something waits on you. A closed lid
  on battery still sleeps.
- **iOS gives a closed app no connection.** Pushes cover the moments that matter. Live Activities
  come in Phase 4.
- **The extension has 24 MB and about 30 seconds.** It links only Noise and the keychain.
- **Cloudflare is a dependency.** If the relay is down, the phone cannot reach the Mac. The Mac
  carries on.
- **v2 may change the event model under the phone.** The projection's exhaustiveness check and the
  fixtures catch it at the change, not on the phone.
- **The daemon may restart with no Realm window open.** Then it has no keys, so the phone shows the
  Mac as offline until Realm is opened. MCP sign-ins behave the same way today.

## Options considered

- **Tailscale to the Mac's RPC port.** This was the v1 spec's sketch. T3 Code pairs this way through
  Tailscale Serve and still needs a relay for its notifications. It costs an account, an install and
  a VPN on both devices, gives no push, and exposes the whole RPC. Rejected.
- **A port opened on the Mac, or UPnP.** Reachable from the internet, and it breaks on most networks.
  Rejected.
- **CloudKit as the relay.** No server to run, and end-to-end encrypted fields. But it has seconds of
  latency and throttled pushes, and the Mac side would need a native CloudKit helper. Rejected for
  live use.
- **The desktop RPC with an allowlist.**
  - The list has to keep up with 202 methods and a v2 in flight.
  - Raw events need the renderer's code to read them.
  - Any rename breaks an older phone.

  Rejected in favour of `mobile.v1`.
- **Secure Enclave keys (P-256).** The push extension needs the same key, and the enclave holds no
  X25519. Rejected for device-only keychain keys.
- **HPKE for pushes.** CryptoKit has it; Electron's Node does not. Noise K does the same job with code
  that already exists for the channel. Rejected.
- **A server on Fly.io or a VPS.** It would work. But a Durable Object per Mac gives isolation, free
  idle sockets and nothing to patch.
- **React Native, Expo, or the renderer in a web view.** Settled by decision 3.

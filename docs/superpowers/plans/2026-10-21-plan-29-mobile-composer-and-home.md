# Plan 29: Realm Mobile's composer and Home, redone

Date: 2026-10-21. Builds on Plan 28 (Realm Mobile). Base: `main` at v2.4.0 (088e1d74).

## The ask

The owner, 2026-10-21, before going to sleep:

> The prompter needs to be redesigned. It looks and feels very unintuitive. You can't add attachments.
> You can't switch model. We need a model selector in there as well. The stop button just feels too
> separate. It could be overhauled. The way sessions are listed does not feel the best. I want a
> setting where you can change how it is listed, such as by most recent, and also a way to switch
> profiles instead of listing all the spaces in one page. That would be nicer as well. Look through
> the cursor app and maybe other apps that do this, like the T3 mobile app, and then steal a lot of
> their design and implement here in Realm. I'm about to go to sleep, so I want to wake up to all of
> this done.

So, in order of what was asked:

1. **A composer that feels obvious.** It takes photos and files, it has a model selector, and Stop is
   part of it rather than a separate circle beside it.
2. **Home lists sessions the way the person chooses,** with a setting for it (most recent among
   them), and shows **one profile at a time** with a way to switch.
3. **Take the design from Cursor's iOS app and T3 Code's mobile app,** which already solved these.

Every one of these is on the phone (`apps/ios`) and on the Mac (`mobile.v1`, `apps/server/src/remote`).

## References

All in `~/Desktop/Home/Work/Projects/realm-scratch/ui-research/` (research done 2026-10-12 for #173):

- `FINDINGS.md`: T3 Code's mobile app and Codex Remote, read from source. §2 "Composer" and
  "Home: the inbox" are the parts this plan takes most from.
- `REFERENCES.md`: ChatGPT's Codex, Cursor for iOS and Manus.
- `cursor/sheet.png`: Cursor's App Store screens. The list ("All Workspaces", grouped "Pinned",
  "Today", then by repo) and the composer ("+ · Follow up… · mic"; focused, a card with "acme main ⌄"
  and a "Composer 2.5 ⌄" model chip on its toolbar).
- `screenshots/t3code/*.png`: T3's store screens.
- `t3code/apps/mobile/src/`: T3's source (MIT; learn the patterns, copy no code). Most relevant:
  `features/threads/ThreadComposer.tsx` (the capsule that becomes a card on focus, Stop in the send
  button's place), `components/ComposerToolbar.tsx` (quiet inline chips), `features/threads/
  composerSendPresentation.ts` (Send / Queue / Steer), `components/ComposerAttachmentStrip.tsx`,
  `features/threads/ThreadSettingsSheet.tsx` (model, reasoning and mode in one sheet),
  `features/home/ThreadListFilters.tsx` (native menus with checkmarks).

## What is taken, and from whom

| | Taken from | In Realm |
|---|---|---|
| A capsule at rest that becomes a card while composing | T3 (`ThreadComposer`), Cursor | The composer |
| `+` for photos, the camera and files | T3, Cursor, Codex Remote | The composer's `+` menu |
| A model chip on the composer's toolbar that opens one sheet for model, reasoning and mode | T3, Cursor ("Composer 2.5 ⌄"), ChatGPT ("5.5 Medium") | Model chip and session settings sheet |
| A permission/mode chip | ChatGPT ("Default" with a hand) | Mode chip |
| Stop takes Send's place while a turn runs and nothing is typed | T3, ChatGPT, Codex Remote | One primary button |
| Queue or Steer while a turn runs, the other a long-press away, each explained | T3 (`composerSendPresentation`) | The same button's menu |
| One list grouped by when ("Today") or by project, switched from a native menu | Cursor ("All Workspaces"), T3 (filters) | List style, in a menu and in Settings |
| Switching which workspaces are shown from the title | Cursor ("All Workspaces ‹"), iOS's own title menus | Profile switcher in the title |

## Design

Native iOS 26 SwiftUI, in the idiom #173 set (Liquid Glass bars, `Palette`, `Fill`, `Radius`,
`Motion`, `Ground` tokens, spoken summaries, Dynamic Type through the accessibility sizes, Reduce
Motion and Reduce Transparency). Haptics stay on selection and copy only. Copy follows design.md
"Language": plain, exact, sentence case, no hype.

### 1. The composer (`ComposerView.swift`)

**At rest** (not focused, nothing typed, nothing attached): one glass capsule across the foot.

```
( +   Message Claude…                         (↑) )
```

**Composing** (focused, or a draft, or attachments): the capsule becomes a glass card with the same
glass, morphing (`Motion`, about 220 ms; a cross-fade under Reduce Motion):

```
┌───────────────────────────────────────────────┐
│ [▣][▣][📄 notes.pdf ×]                          │  attachments, scrolling sideways
│ Message Claude…                                 │  the field: 1 to 8 lines, then it scrolls
│                                                 │
│ (+)  ✳ Opus 5.5 ⌄   ✋ Ask each time ⌄       (↑) │  the toolbar
└───────────────────────────────────────────────┘
```

- **`+`** is a native `Menu`: Photo Library (`photo.on.rectangle`), Take Photo (`camera`, only where
  the device has a camera), Choose Files (`folder`). It is offered only when the Mac answered
  `session.options` (an older Mac would drop the files). At the limit, its items say why they are off:
  "Up to 6 files in one message."
- **The model chip**: the agent's mark in its colour, the model as the desktop names it, `chevron.down`.
  It opens the session settings sheet (below). A quiet inline control, not a filled pill (T3's
  `ComposerInlineControl`): 44 pt to touch, the text ink2, emphasised to ink.
- **The mode chip**: what the agent may do, with a glyph that says it. In Build, the permission rung
  ("Ask each time" `hand.raised`, "Accept edits" `pencil`, "Full access" `exclamationmark.shield`); in
  Plan, "Plan" (`list.bullet.clipboard`); in Ask, "Ask" (`questionmark.bubble`). A native `Menu` with
  two inline pickers (Mode, then Permissions while in Build), so changing it is two taps. Shown only
  where the agent offers either.
- At the accessibility text sizes the chips scroll sideways and the primary button stays put.
- The field's placeholder keeps today's honest words ("Sends when your Mac wakes" and the rest).
- **The context line above the field goes**: the model chip says it now.

**The primary button** is the only button at the end, and what it is follows from the state. It is a
pure function (`ComposerAction`), tested like `ComposerButtons` was:

| Turn | Something to send | Button | Long-press |
|---|---|---|---|
| idle | no | Send, disabled (`arrow.up` on a quiet fill) | |
| idle | yes | Send (`arrow.up`, accent fill) | |
| running or waiting | no | **Stop** (`stop.fill`, ink fill, ground glyph) | |
| running or waiting | yes | The Mac's mid-turn choice: **Queue** (`list.number`) or **Steer** (`arrow.turn.left.up`) | The other one, and Stop, each with what it does |

- "Something to send" is text or an attachment.
- Queue's line reads "Sends when this turn ends." Steer's reads the Mac's `steerNote` for the agent.
- Stop needs the Mac: while it is away, Stop stays in place, greyed, as today. Send, Queue and Steer
  go to the outbox as messages do now.
- The separate glass Stop circle beside the field is gone.

**Attachments**

- **Photos** (`PhotosPicker`, images, as many as are left) and **the camera** (a
  `UIImagePickerController` wrapper) are made JPEG: the long edge at most 2048 px, quality about 0.82.
  That drops location metadata and keeps a photo near 1 MB, under what Claude takes inline.
- **Files** (`.fileImporter`, any type, several) are read whole with security-scoped access. One over
  the Mac's `maxBytes` is refused with a toast: "notes.pdf is over 8 MB, the most your Mac takes from
  iPhone."
- **Where they wait**: each attachment is written to the app's Application Support folder
  (`Outbox/<uuid>.<ext>`, excluded from backup), so a message waiting on a sleeping Mac survives a
  relaunch. The file is deleted once its message settles, or when it is discarded or removed from the
  draft.
- **The strip**: images are 56 pt rounded thumbnails (radius 12); other files are chips with their
  type's glyph, name and size. Each has a remove button (`xmark.circle.fill`, with an accessibility
  label naming the file). Tapping one previews it with Quick Look.
- **In the transcript**: a sent message shows its attachments under its bubble while it travels
  (`OutgoingMessageView`) and once the Mac has it (a user row's `attachments`). Images are thumbnails
  fetched with `session.file`, cached as made files' thumbnails are; other files are chips.

**The session settings sheet** (the model chip's): `presentationDetents([.medium, .large])`, titled with
the agent's mark and name.

- **Model**: the agent's models, the current one checked. The `id: null` row is "Default", with the
  default's name under it.
- **Reasoning**: shown only where the chosen model, or the agent, takes levels. A menu-style picker row
  ("Reasoning · High"), "Default" first.
- **Mode**: a segmented Build | Plan | Ask, as offered, with a footer saying what the chosen one does.
  - Build: "Changes files and runs commands as its permissions allow."
  - Plan: "Plans first, and changes nothing until you approve the plan."
  - Ask: "Answers questions and changes nothing."
- **Permissions** (in Build, where the agent has them), each row with one line under it:
  - Ask each time: "Asks before each edit and command."
  - Accept edits: "Edits files without asking, and asks before commands."
  - Full access: "Runs everything without asking."
- Each change goes at once (`session.configure`): the check moves, a small spinner shows until the
  Mac answers, and a refusal puts it back with a toast.
- While the Mac is away, the sheet shows what was last known, disabled, with "Connect to your Mac to
  change these."
- The footer reads: "Changes apply from your next message."
- Options are cached per session in `AppModel`, fetched in the background when a session opens, and
  fetched again when the sheet opens.

### 2. Home (`HomeView.swift`)

**One profile at a time.**

- The title is the profile's name ("Work"). `.toolbarTitleMenu` lists the Mac's profiles in their
  desktop order, the current one checked (a `Picker` inside the menu), each with its emoji or glyph and
  "2 waiting on you" where Needs you has some. "All profiles" comes last and shows everything, as Home
  does today.
- Shown only when the Mac has more than one profile. The choice is kept on the phone, per Mac. The
  default is the first profile.
- **What waits in another profile is not hidden**: one quiet row at the head of the list, "School has
  2 waiting on you ›", switches to it.
- Search searches what the chosen profile lists.

**List style**: a setting, in two places bound to the same `@AppStorage` keys.

- **Where**: a Home toolbar `Menu` (`line.3.horizontal.decrease.circle`, labelled "View options"), and
  Settings ▸ "Session list".
- **List**:
  - By space: today's sections, scoped to the profile.
  - Most recent: one list, newest activity first, each row naming its space as Needs-you rows do.
  - By day: the same rows under Today, Yesterday, Previous 7 days and Earlier.
- **Order spaces** (By space only): As on your Mac, or Recently active first (by each space's newest
  session).
- **Needs you first** (on by default): the Needs you section at the head. Off, those sessions sit where
  their activity puts them, still saying "Waiting on you".
- In By space, spaces with no sessions are left out.
- **More than five**: a space's footer "N more on your Mac" becomes a "Show all N" row, and a section's
  head opens the space.

**A space's page** (`Route.space(id)`):

- The space's glyph and name as its title.
- Every listed session, most recent first, paged 50 at a time with `space.sessions` (the next page
  loads as the end comes into view).
- Pull to refresh, and search over what is loaded.

### 3. New session (stretch, after 1 and 2 are done and checked)

- **How it opens**: a compose button (`square.and.pencil`) beside Home's search, as Mail has it.
- **The sheet** is titled "New session". It has:
  - a space chip (the profile's spaces; the last one used is the default);
  - an agent chip (`agents.list`; the Mac's default first);
  - the composer's model and mode chips, and attachments;
  - the field, and Start.
- **Start** makes the session (`session.create`) and opens it.
- **While the Mac is away**: Start is off, with "Start a session while your Mac is connected." New
  sessions do not wait in the outbox in this pass.

## The protocol (`mobile.v1`, `packages/remote/src/mobile-api.ts`)

The schemas are committed first, on `feat/mobile-composer`. Both sides build against them. Everything
new is optional or a new call, so an older phone and an older Mac keep working with a newer other side.
A phone learns what the Mac supports from whether `session.options` answers.

**`home.get`** takes an optional `profileId`. What it adds:

- `profiles`: in the desktop's order, each with how many sessions Needs you lists in it;
- `spaces[].profileId`;
- `createdAt`, `effort` and `permissionMode` on every row;
- `profileId`: the scope `recent` was gathered for;
- `recent`: at most 40 listed sessions in that scope, newest activity first.

Spaces keep their newest five rows. Needs you stays every profile's.

**`space.sessions`** (`id`, `offset`, `limit` ≤ 100): a space's listed sessions, newest activity first,
and whether there are `more`. "Listed" is Home's rule: a session item that is not archived.

**`session.options`** (`id`): the session's agent, as `AgentOptions`.

- **`models`**: from the Mac's probe of that agent, falling back to the curated list, named as
  `modelLabel()` names them, with the default as `id: null`.
- **`efforts`**: per model where a model takes levels, and per agent for ACP's own levels.
- **`modes`**: from `offeredModes`.
- **`permissions`**: `PERMISSION_MODES`, where `AGENT_SUPPORTS_PERMISSION_MODES` says Realm can set them.
- **`steerNote`**: from `steerNote(kind)`.

It also carries:

- the session's current model, its label, effort and permission mode;
- `midTurn`, from `sessions.midTurnMode`;
- the attachment limits (`SEND_LIMITS`: 6 files, 8 MB each, 10 MB in all).

**`session.configure`** (`id`, any of `model`, `effort`, `mode`, `permission`) checks each value
against the options, then calls `sessions.setOptions`.

- **Mode**: Plan → `"plan"`, Ask → `"ask"`.
- **Build**: the `permission` given; else the session's own rung if it has one; else the Mac's
  `sessions.defaultPermissionMode`; else `"default"`.
- **A `permission` without `mode`** means Build with that rung.
- It answers with the options as they are now.

**`session.send`** gains `attachments` (`name`, `mime`, base64 `data`).

- **Text**: may be empty when attachments come with it; a message with neither is `INVALID_PARAMS`.
- **Checks on the Mac**: the count, each size and the total against `SEND_LIMITS`; strict base64; the
  name sanitised as the desktop sanitises a paste.
- **Where each goes**: it is written where a desktop paste goes (`<home>/tmp/attachments/<random>-<name>`,
  swept after 24 hours), so the session's `user_message` keeps a path that works.
- **Then** `sessions.send` with `{ path, mime }`, as the desktop's prompter sends.
- **The image check**: an image must be JPEG, PNG, GIF or WebP, the types every adapter takes inline.

**`session.create`** gains `model`, `effort`, `mode`, `permission` and `attachments`. `text` may then
be empty.

**`agents.list`** returns:

- `AgentOptions` for each agent a person can choose (`SELECTABLE_AGENT_KINDS`, as the desktop's new
  session offers them), with `available` and `note` from the probe;
- the Mac's default agent;
- `midTurn`;
- the limits.

**Rows**:

- A user row carries `attachments` (`path`, `name`, `mime`) from its `user_message`.
- `session.file` previews those paths too, and still no others.

**PROTOCOL.md §8** says all of the above. The generated fixture (`packages/remote/test/fixtures/
ts-api.json`) carries an answer of each new call, and a user row with attachments, for RealmKit's
decoding tests.

## Work, branches and who does what

| Branch (worktree in `realm-worktrees/`) | Does |
|---|---|
| `feat/mobile-composer` (`mobile-composer`) | The schemas and this plan, then integration, gates and the PR |
| `feat/mobile-composer-mac` (`mobile-composer-mac`) | The Mac: everything under "The protocol", tests, fixtures, PROTOCOL.md, staging for the live run |
| `feat/mobile-composer-ios` (`mobile-composer-ios`) | The phone's composer, attachments, settings sheet, Send/Queue/Steer/Stop; then New session |
| `feat/mobile-home-ios` (`mobile-home-ios`) | The phone's Home: profile switcher, list styles, Settings ▸ Session list, space page |

**RealmKit changes are split by feature.**

- Composer: `SessionOptions` and the related types, the outbox's attachments and delivery, and the
  user row's attachments.
- Home: `Profile`, `Home.recent` and `Space.profileId`, and `space.sessions`.

Both add to `Models.swift` and `MobileAPI`, in separate places, so the merge is additive.

## Gates and proof

Every branch, before it is handed back:

- `SHELL=/bin/bash pnpm vitest run` (rerun a lone failure in isolation before believing it);
  `pnpm -r typecheck`; `pnpm build`.
- Mobile gates: `pnpm ios:test` (RealmKit) and `pnpm relay:test`.
- The app-hosted tests:
  - first `xcodegen generate --spec apps/ios/project.yml`;
  - then `xcodebuild test -project apps/ios/Realm.xcodeproj -scheme Realm -destination id=<udid>
    -derivedDataPath apps/ios/.build/DerivedData`.
- The live run: `pnpm --filter @realm/server exec tsx ../ios/scripts/screens-live.mts --ui --udid
  <udid>`, on the built server and a scratch home. It gets new phases for what changed.
- **The screenshots are read back and judged,** not just taken: dark and light, the largest text
  size, and Reduce Transparency.
- **For each behaviour, ask which one-line mutation would break it and whether a test fails.** Run the
  ones in doubt. Commit before mutating anything.

## Rules for every session on this

- **Where to work**: only in the worktree named above. Never in the primary checkout, never in
  `~/Realm/work/realm` (another session's), never in the owner's `~/Realm`.
- **Live runs**: on a scratch home (the live script makes one) with the fake agent standing in. No
  real agent turn; it bills the owner.
- **Disk**: the Mac has about 20 GB free. Keep DerivedData inside the worktree's `apps/ios/.build`,
  run one `xcodebuild` at a time per worktree, and delete DerivedData once the branch is handed back.
- **Commits**: add by path, never `git add -A`; commit early. No AI attribution in commits, trailers
  or PR text. Do not push, and do not open PRs: the coordinator does.
- **Never `git stash`.** The stack is shared across worktrees. Use a WIP commit.

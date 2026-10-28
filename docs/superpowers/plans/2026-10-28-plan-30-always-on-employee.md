# Plan 30: Realm as an always-on employee

Date: 2026-10-28. Base: `main` at v2.5.1 (609b5720). Builds on the 2.6.0 memory work (`feat/memory-*`,
shipping 2026-11-02), Plan 25 (machines), the 2.5.0 remote runtime, Plan 28 (Realm Mobile) and
Plan 24 (inline UI).

## The ask

The owner, 2026-10-28:

> I want an always on, frontier model powered employee that can use its own computer, and can use my
> computer 24/7 that self organizes all of its tasks into channels so that its easy to keep track of all
> the things we've done together. And I want to be able to control this agent on mobile, web, desktop,
> and most importantly real time voice.

Their list: an Opus-5.5-level model that never delegates to a worse one; cloud and local code sessions;
real-time voice with tool use; Codex-level computer use; Artifacts-quality decks, docs and design; a
mobile app with Duet's UI; inline mini apps across many tools; webhooks; social media on every
platform; plugins.

The order they chose: **channels → an always-on machine (with a picker under the prompter) → real-time
voice → connectors as clean as Codex's, with inline mini apps → web client → social connectors.**
Two rules on top: **never downgrade, including background work**, and **bring T3 Tots' companion
experience inside Realm** to run the agent teams.

## What T3 Tots is, and what we take from it

T3 Tots (github.com/Deepusleepy/t3-tots, MIT, v1.4.29) is a companion for T3 Code that runs inside
Grok Bot. It is 22 skills over a CLI that talks to T3 Code's local websocket API, and a listener that
sends T3 events to a webhook. Its demo pitches it as "your outer loop", and that is the idea we take:
**one agent above all the others**, which handles the dull parts and brings up only what needs you.

| T3 Tots | What it does | In Realm |
|---|---|---|
| `t3-waiting`, `t3-phone-answers` | Every thread blocked on you, each with a ready-to-send reply; answer by tapping on the phone | Needs you already exists. The Lead adds ready-to-send replies, and the phone, web and voice can all answer |
| "Answered for you" | Answers a routine question from what it knows you prefer | The Lead answers from the memory repo, marks the answer "Answered for you" and links the memory it relied on. Undoable |
| Approvals | A card for each approval; never approves without your yes; while you're away it declines risky commands and tells the thread a safer way | Same rule. The Lead **never** approves on its own |
| `t3-watch`, delegated mode | "Ping me when X finishes"; "I'm away, keep it moving": nudge stalled threads, resume after a usage limit | Watches on sessions, runs, PRs and CI. An Away mode that nudges, resumes at the limit reset (Realm already reads plan limits), and keeps a list of what happened while you were away |
| `t3-digest`, `t3-project-report` | "Wake up to a briefing": threads finished, PRs ready to merge, questions for you | Morning briefing and weekly wrap-up in the Lead's channel; a project report as an HTML document on request |
| `t3-pm-thread` | A PM thread plans the work, pushes back, starts worker and reviewer threads, and checks results before calling it done | PM mode, built on Teams (Phase 1 is on main; #139–142 are open), `agent_start`, `agent_review` and goals. Lands or replaces orchestrator PR #129 |
| `t3-project-tracker` | A living tracker: goal, milestones, decisions, next steps | The channel summary (Phase 1) |
| `t3-sync`, "Move projects" | Keeps your computers' setup in sync; moves a project to another computer | Phase 2, across Realm servers |
| `t3-handoff` | Hands a thread to a cloud agent that returns a PR | Phase 2: move a session to a cloud machine |
| "Just say it" | Voice → "New project: habit tracker. Plan, build…" | Phase 3 |
| `t3-save-learnings`, `t3-templates`, `t3-get-output`, `t3-usage`, `t3-checkup` | Lessons to AGENTS.md; prompt templates; artifacts into chat; usage; health | Memory repo (2.6.0); saved prompts; documents in channels; Usage page; a health check of each machine |

What we do **not** copy: driving another app through an unofficial API and reading its database. In
Realm the Lead is a first-class session, and Realm's own tools give it every one of these powers.

## Principles

1. **Never downgrade.** Every model call Realm makes runs on the frontier model the user picked (Opus
   5.5 today), background work included. One constant in `packages/adapters` decides it, and the
   following all use it:
   - titles and recaps (Haiku 4.5 today, on every turn — moved in 2.6.0);
   - memory extraction and the weekly cleanup (2.6.0);
   - the Lead;
   - channel filing;
   - the "brain" behind voice.

   This costs more: the recap becomes an Opus call per turn. The one exception the owner approved is
   voice's fast front end (Phase 3). It handles speech only. It never answers from its own knowledge,
   never decides anything, and hands every request to Opus. Laya stays in shadow mode only; it never
   acts.
2. **The Lead is the outer loop.** One always-on Opus session per profile. It watches, answers, nudges
   and briefs, and it files work into channels. It acts only through Realm's own tools and approval
   rules, so whatever is denied to a user's session is denied to it too.
3. **Realm owns the state.** Memory (2.6.0), channels, machines and connectors live in Realm, not in
   any one engine's config. So every engine and every client sees the same employee.
4. **Nothing outward without you.** Sending, posting, paying and approving a risky command always come
   back to the user, through whatever surface they're on: card, notification or voice confirmation.

## Phase 1 — Channels and the Lead

**What exists:** spaces and sessions, which the user files; the Needs you queue; recaps; schedules;
goals; delegated agents; Teams Phase 1; `sessions_list` / `session_read` / `agent_answer`; the memory
repo, with one folder per space from 2.6.0.

**Build:**

- **Channels inside a space**, like Slack channels inside a workspace: a `channels` table and a
  `channelId` on sessions, runs, schedules and webhook events.
  - The Lead files new work into a channel. To avoid a second model call, it does this in the same
    Opus call that already writes the session's title.
  - You can move anything. A channel the Lead created is marked as new.
- **The channel page:**
  - a running summary: where things stand, decisions, next steps, open questions;
  - a timeline of everything filed there: sessions, runs, PRs, schedule firings, webhook events,
    documents;
  - its memory at `spaces/<folder>/channels/<slug>.md` in the memory repo, so every engine can
    read it.
- **The Lead's own channel** at the profile level. This is where you talk to the employee from any
  space, the phone, the web or by voice. Briefings arrive here.
- **The Lead's loop,** taken from the table above:
  - waiting items with ready-to-send replies;
  - "Answered for you" under decision rules you set;
  - approval cards;
  - Away mode: nudge, resume at the limit reset, decline risky approvals with a redirect;
  - watches;
  - the morning briefing;
  - PM mode.
- **The sidebar** groups sessions by channel; Needs you stays on top.

**Decisions needed before the spec:**

- channels per space (recommended) or one set across the whole profile;
- what the Lead may decide alone. Recommended default: it answers questions whose answer is in
  memory, and nothing else.

**Proof:**

- With the fake agent, a session started by text gets filed, its summary updates, and it shows on
  the phone.
- A waiting question gets "Answered for you" from a seeded memory.
- An approval is never auto-accepted. A mutation that lets the Lead approve must fail a test.

## Phase 2 — An always-on machine, picked under the prompter

**What exists:**

- The strip under the composer shows a static chip, "Agents run on this Mac — {machineName}"
  (`Composer.tsx`, `strip-machine`).
- `realm serve` (2.5.0) runs headless anywhere Node 22 runs, Linux included. It has Tailscale, SSH
  and TLS options, `realm service install`, saved remotes with access tokens, and phone pairing
  against a remote server.
- Plan 25 machines (`realm-vm`) drive screens elsewhere: QEMU guests and remote desktops, by pixels.

**Build:**

- **The chip becomes a picker** with three groups:
  - **This Mac.**
  - **Your computers:** any Realm server you've connected (a Mac mini, a Windows PC, a Linux box).
    "Connect another computer" shows the one command to install `realm serve` there, then pairs it
    the way a phone pairs.
  - **Cloud:** a list of VM providers and sizes. Realm creates the VM in **your own** provider
    account, installs `realm serve`, connects it, and can stop or destroy it.
- **The desktop app talks to remote servers** the way the CLI does today. A session, a space or a
  channel says where it runs. A session can be moved to another machine through git, and its
  worktree is recreated there.
- **Each machine is labelled with what it can't do.** When the chosen machine can't do what the
  session's work needs, the composer says so plainly:

  | Machine | Works | Doesn't |
  |---|---|---|
  | macOS | everything | — |
  | Windows | coding agents, terminals, browser panes, documents, memory, git, Docker | Xcode, iOS/Android simulators, `realm-computer` (Mac accessibility), `mac` CLI (Calendar, Reminders, iMessage), Apple signing and notarization, Mac-only skills. Paths and shell differ (PowerShell) |
  | Linux / cloud VM | coding agents, terminals, headless browsers, documents, memory, git, Docker, servers that stay up | Xcode, iOS simulators, Mac apps, `mac` CLI, a desktop unless the VM has one |

  The Lead sends iOS and Mac-app work to a Mac automatically.
- **The Lead lives on the always-on machine,** along with schedules and webhooks. Your Mac becomes
  one computer it uses whenever the Mac is awake: `realm-computer` locally, and Codex's own
  `computer_use` (stable in codex 0.163) on Codex sessions. Mac-only steps queue until the Mac
  wakes. Wake-on-LAN for a Mac mini.
- **Setup sync between machines** (T3 Tots' `t3-sync`): skills, connectors and settings. Agent CLIs
  still sign in on each machine.

**Research for the spec:** which cloud providers to offer first. Candidates:

- general VMs: Hetzner, DigitalOcean, AWS EC2, GCP;
- Apple-silicon Mac hosting: EC2 Mac, MacStadium, Scaleway;
- disposable sandboxes for single sessions: E2B, Daytona, Modal.

Compare their create/destroy APIs, snapshots, cost to keep a VM always on, and Mac availability.

**Decision needed:** cloud VMs in the user's own provider accounts (recommended to start), or
Realm-hosted machines later.

## Phase 3 — Real-time voice: a fast talker that hands everything to Opus

**Design:** a voice front end handles listening, turn-taking, being interrupted mid-sentence,
short acknowledgements ("on it"), and reading results aloud. Every request goes to the Lead or the
current session as text, so Opus does all the thinking and every tool call. Destructive actions
still need an on-screen yes.

**Options to measure in a spike.** Measure time to first audio, how it handles being interrupted,
cost, and privacy.

- **On-device, Apple** (available on this Mac, macOS 27.2): `SpeechAnalyzer` / `SpeechTranscriber`
  in Speech.framework for streaming speech recognition; Foundation Models (the on-device language
  model, with a `Tool` protocol) as the talker; AVSpeechSynthesizer for speech, premium and Personal
  Voice included. It's free, private and works offline, and the same frameworks exist on iPhone.
  It runs from a Swift helper, as Realm's accessibility helper already does.
- **Cloud speech-to-speech** with function calling, for example OpenAI's realtime models or Gemini
  Live. Better voice and turn-taking, but it costs money and the audio leaves the Mac.
- **No talker:** streaming transcription → Opus → streaming speech. Opus end to end, but slower to
  start answering.

The owner leans towards a fast talker that passes everything to Opus. The plan is to spike the
on-device Apple stack first and keep cloud as an option in Settings.

**Surfaces:**

- desktop: a hotkey and a voice control in the composer;
- the iPhone app (Duet's UI; references needed);
- the web client (Phase 5).

## Phase 4 — Connectors as clean as Codex's, and inline mini apps

**What exists:**

- MCP connections behind one gateway, with OAuth tokens kept in realm-server;
- the guide iframe bridge;
- Plan 24 W1 (inline UI in the transcript).

Codex's `apps` feature uses the connectors linked in ChatGPT, which is the "connect once, it just
works" feel the owner wants.

**Build:**

- **A connector catalog with one-click OAuth.** Slack, Gmail, Google Calendar and Drive, GitHub,
  Linear, Notion, Figma, Discord and more. Each gets first-class tools (search, read, write) and
  works in **every** engine, as memory does.
- **Inline mini apps** on the **MCP Apps** standard: an MCP server can ship interactive UI, which
  Realm renders sandboxed inline in the transcript and the channel, as the guide frame does. Codex has
  `enable_mcp_apps` in development. Realm also draws its own cards for:
  - email: reply, archive;
  - Slack: reply in the thread;
  - calendar: accept, decline;
  - a PR: merge, which needs your yes;
  - approvals.
- **Webhooks:**
  - **inbound, one URL per channel.** They are received by the relay (Cloudflare) and forwarded to
    your Realm over the paired link, so no port opens on the Mac. An event wakes the Lead or a session
    and is filed into the channel.
  - **outbound:** run ends and questions go to your own endpoints (like T3 Tots' `t3listen`).

## Phase 5 — Web client

The relay already carries the phone's encrypted link (`packages/remote`), and `@realm/view` already
holds the shared Needs you model. The web client is one more paired client: noise over WebCrypto,
served from realm.computer or from your own Realm server. It reuses the desktop renderer's React
views, with the transport swapped.

## Phase 6 — Social connectors

- X, LinkedIn, Instagram, TikTok, YouTube, Threads, Bluesky and Reddit. Use the official API where
  one exists, and a browser pane with your sign-ins otherwise (aurafarm already posts to TikTok
  this way).
- **The flow:** draft, then an approval card, then one tap or one spoken yes posts it at a paced slot
  (Teams Phase 3, #142).
- Analytics are read back into the channel.
- Nothing is ever posted without approval.

## Later, from the list

- Artifacts-quality decks: a slide format in Documents, plus design skills.
- The mobile app in Duet's UI. The open mobile stack (#230–235) follows Manus; decide whether to
  restyle it or redo it.
- Plugins: skills plus connectors already cover most of this; it may need a catalog page.

## How it gets built

- Each phase gets its own spec, then a stack of PRs, then a release.
- Streams run in parallel only where they touch different files.
- 2.6.0 (memory and Documents) ships first, on 2026-11-02.
- The Phase 1 spec starts as soon as the 2.6.0 builders land. Phase 1 needs the memory folders, and
  starting more agents before then would risk the plan limit pausing the Monday release.

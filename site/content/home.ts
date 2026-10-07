/**
 * The landing page's claims, and the capture that is evidence for each.
 *
 * One claim per section, each carrying a real product view — the page argues now, and design.md's
 * rule for a page that argues is that it shows the product rather than describing it. `capture` is a
 * slug in `public/product/manifest.json`; a section whose capture has not been taken renders its
 * claim without one rather than borrowing a picture of something else.
 *
 * Everything here is a fact about the shipped app. Anything Realm cannot do yet belongs in the
 * changelog, not on this page.
 */
import type { Focus } from "@/lib/frames"

export type { Focus }

export type Claim = {
  /** Stable id, used for the section's own heading anchor. */
  id: string
  title: string
  body: string
  /** A slug in the capture manifest, or null for a claim that has no picture yet. */
  capture: string | null
  /** What the picture is evidence OF. Required wherever there is one. */
  caption?: string
  /**
   * Which part of the capture this claim is actually about.
   *
   * Every scene is shot at the whole 1440x900 window, and most of them spend a good half of it on
   * the dimmed sidebar and empty canvas either side of the thing being claimed. Shown whole in a
   * page column the subject lands around 60% of its own size, which is a picture of the product
   * rather than a readable one. `x` and `y` are the point that stays in the middle of the frame and
   * `span` is how much of the capture's width the frame shows, both as fractions of the source.
   *
   * A point near an edge is held back to the edge rather than dragging blank space into frame, so
   * these are aims, not promises — see `Claim.tsx`.
   */
  focus?: Focus
}

export const claims: Claim[] = [
  {
    id: "spaces",
    title: "Every space in one sidebar.",
    body:
      "Each space in a profile gets its own section of the sidebar: its name in its colour, a count of what's waiting and working, and its sessions. Needs you sits on top and collects every session that's waiting on a permission or a question, from every space and every profile. Open a row and you can answer it right there. Switching spaces loads nothing, because they're all loaded already.",
    capture: "sidebar",
    /* The column, from the profile down: Needs you, then the spaces and their sessions. */
    focus: { x: 0.25, y: 0.27, span: 0.56 },
    caption: "Three sessions waiting on you (two questions and a sub-agent's permission, one from another profile) above every space's sessions.",
  },
  {
    id: "transcript",
    title: "A transcript you can read.",
    body:
      "A turn isn't a wall of log. Tool calls fold into rows you can open, a plan shows up as a plan, and a reply can carry a chart, a diagram or a comparison. When a turn changes files, it ends with a card listing each file and its line counts from git. Review opens that turn's diff, and Undo is there when a checkpoint can take back exactly that turn. Every prompt also leaves a tick down the edge of the pane, so a long session has a map.",
    capture: "session",
    /* The answer from its first line to the turn's card under it. */
    focus: { x: 0.5, y: 0.47, span: 0.75 },
    caption: "One turn: the answer, the files it named as links, and the two it edited, with Review and Undo.",
  },
  {
    id: "agents",
    title: "Bring the agent you already use.",
    body:
      "Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code and Grok all run here, most of them through one Agent Client Protocol adapter. Each keeps its own login, models and permission modes. The model picker groups models by the harness that runs them, and its footer holds each model's effort levels and fast mode. Realm never asks for an API key. Signing in runs the agent's own login, and you're the one who approves it.",
    capture: "models",
    /* The prompter and the whole picker under its chip, from the search to the effort track. */
    focus: { x: 0.615, y: 0.66, span: 0.77 },
    caption: "Every installed agent's models in one list. Opus 5.5 is picked, at Max, with fast mode on.",
  },
  {
    id: "delegation",
    title: "Hand work to other models.",
    body:
      "Ask in plain words (\"have GPT-6 Luna build this\") or pick models in a session's Agents tab and say what to build. The session's agent splits up the work, starts a sub-agent on each model through whichever harness runs it, waits for the reports and tells you what each one did. Every sub-agent gets its own line in the transcript, and its own session is a click away.",
    capture: "delegation",
    /* The lead's lines and the Agents tab beside them. */
    focus: { x: 0.615, y: 0.38, span: 0.77 },
    caption: "Two sub-agents on two harnesses. One finished with its report, the other is waiting on a permission.",
  },
  {
    id: "gateway",
    title: "Your tools, without your credentials.",
    body:
      "Linear, Notion, Slack, GitHub, Jira, Figma and Sentry connect in one click, and you sign in through the app. A connection belongs to the space instead of an agent, so every session in the space reaches it through one Realm endpoint. The agent gets the tools and never the credential: it calls Realm, and Realm calls the server. Every call is logged with its arguments and what came back, and your own MCP servers go in the same place. OAuth connections are encrypted with a key kept in the macOS Keychain. A key you paste into a custom server isn't, and the app tells you so right at that field.",
    capture: "connections",
    /* The page's head and the first two rows of cards, close enough to read what each one grants. */
    focus: { x: 0.51, y: 0.36, span: 0.7 },
    caption: "Connecting an app to a space. One click each, and every session in the space can use them.",
  },
  {
    id: "review",
    title: "Review pull requests without handing over GitHub.",
    body:
      "Code review lists your pull requests through your own gh, so Realm never holds a GitHub token and sees exactly what gh sees. A pull request opens on its summary and its changes. A reviewer reads the diff in read-only mode, on the model and effort level you pick, and leaves its findings on the page. None of its findings and none of your comments reach GitHub until you press Submit review.",
    capture: "review",
    /* The request, the reviewer's findings and the facts beside them, clear of the column. */
    focus: { x: 0.62, y: 0.38, span: 0.76 },
    caption: "A pull request's summary with three findings from a reviewer, one of them on a line the diff doesn't show.",
  },
  {
    id: "sandbox",
    title: "Confine what an agent can touch.",
    body:
      "A space can run its agents and terminals inside a macOS Seatbelt policy. Its checkouts and toolchain caches stay writable, the files in your home that run things later can be read but not changed, and credential folders can't be read at all. The policy covers the process and everything it starts. Seatbelt isn't a container and the network stays open, so this limits what a session can damage or read, not what it can send. It's off by default, per space, because a list of writable folders that hasn't met your toolchain yet can break a build.",
    capture: "sandbox",
    /* The three posture cards, not the settings page they sit on. */
    focus: { x: 0.615, y: 0.41, span: 0.68 },
    caption: "The three postures a space can take, set to the one it ships with.",
  },
  {
    id: "durable",
    title: "Work that outlives the window.",
    body:
      "realm-server keeps running after you close the window, so a long turn finishes whether you're watching or not. Tasks can run on a schedule, and every run is a real session you can read and pick up from. Each turn is bracketed by a checkpoint. Restoring one puts the files back, and for Claude it rewinds the conversation too.",
    capture: "schedules",
    /* The whole width: the column of tasks, the run and the task's card are one picture. */
    focus: { x: 0.5, y: 0.43, span: 1 },
    caption: "Three tasks, each on its own model, and one run open as its own session next to the task's card.",
  },
]

export type Facet = { title: string; body: string }

/**
 * What a realm is made of: the six faces of the mark, in the order they arrive (`ORDER` in
 * lib/dimension/faces.ts), so the sentence beside a face is about the face that is landing. The walls
 * come first, and the agent last, as the doorway's lit back.
 *
 * A realm is a place rather than a stack of layers, so these are what the place contains, each one
 * something the shipped app does, with the limit stated wherever there is one.
 */
export const facets: Facet[] = [
  {
    title: "The checkout",
    body: "A space points at your code, one checkout or several, and its sessions work there. Every turn gets a checkpoint, so you can put the files back.",
  },
  {
    title: "The terminal",
    body: "Real terminals next to the agent. The agent can read what a terminal is actually showing on screen, not a raw log, and answer a prompt that's waiting in it.",
  },
  {
    title: "The browser",
    body: "A browser pane that stays signed in, which agents can read and drive. It stops at a consent screen: approving a sign-in is your click unless the space says otherwise.",
  },
  {
    title: "The tools",
    body: "Linear, GitHub, Slack, Notion and your own MCP servers, through one gateway per space. Agents get the tools but never the credentials, and every call is logged.",
  },
  {
    title: "The boundary",
    body: "A macOS sandbox a space can put its agents in. The checkout stays writable and credential folders can't be read. It's off by default, because a sandbox that hasn't met your toolchain yet can break a build.",
  },
  {
    title: "The agent",
    body: "Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code or Grok, each with its own login, models and permission modes. Realm never asks for an API key.",
  },
]

/** The eighth step, when the view pulls back and the realm is one of many. */
export const facetsMany: Facet = {
  title: "One for every project, all at once.",
  body: "Your spaces sit side by side, each with its own agents working. The sidebar shows all of them at once with what's waiting and working in each, and Needs you at the top collects anything that's stuck on you.",
}

/** The seventh step, when all six are in. */
export const facetsCoda: Facet = {
  title: "That's a realm.",
  body: "Make one for every project. They run side by side, none of them can reach another's tools, and each one is right where you left it when you come back.",
}

/**
 * The interlude between the claims: delegation, told in the order the tree draws it
 * (lib/dimension/tree.ts). Every sentence is the delegation code's own behaviour (`agent_run` and
 * `agent_start`, `MAX_DELEGATION_DEPTH`, the fenced final report), and `realm-agent` is on by
 * default, so "an agent can" is true of a fresh install rather than of a setting.
 */
export const delegation: Facet[] = [
  {
    title: "One agent can start more.",
    body: "An agent in Realm can hand work to other agents. Each one is a real session in the space, so you can open it and watch it work.",
  },
  {
    title: "Several at once.",
    body: "Independent tasks run in parallel, in the space's checkout, an environment you name, or a fresh worktree. A sub-agent asks for permission like any other session, and none of them gets to skip that, even if it's asked to.",
  },
  {
    title: "Two levels deep, and that's it.",
    body: "A sub-agent can hand work off once more. Past that, Realm says no, because every level is one more agent somebody has to keep track of.",
  },
  {
    title: "Everything comes back.",
    body: "Each sub-agent sends a final report to the agent that started it. Its whole run stays in its own session, and the transcript gives it a line of its own when it's done.",
  },
]

export type Question = { q: string; a: string }

/**
 * Answers, not reassurance. Each one states the limit as plainly as the capability: a FAQ that only
 * says yes is an advertisement with a different shape.
 */
export const faq: Question[] = [
  {
    q: "Which agents can I run?",
    a: "Claude Code and Codex have their own adapters. Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code, Grok and others speak the Agent Client Protocol and share one. Claude needs no install, because Realm ships with Claude Code, and Codex installs and signs in during first run. You install the rest yourself, and Realm checks what's on your Mac and gives you the exact install or login command for anything that's missing.",
  },
  {
    q: "Do I need an API key?",
    a: "No. Realm drives the CLI you already have, on whatever plan or key you already pay for. It never proxies a provider's traffic and never asks for a key.",
  },
  {
    q: "Where does my work live?",
    a: "On your Mac, under ~/Realm. Transcripts, documents, skills and checkpoints are files and a SQLite database on disk. Nothing is uploaded, and there's no account to make.",
  },
  {
    q: "Can an agent read my tokens?",
    a: "Not through the gateway. Connections are proxied per space: the agent calls Realm, Realm calls the server, and the credential stays on Realm's side. At rest, it depends on the kind. An app you connect in a click stores an OAuth token encrypted with a macOS Keychain key. A key or header you paste into a custom MCP server is stored in Realm's database in plain text, and the app says so next to the field. Saved website sign-ins are the strictest: encrypted, never handed to an agent, and every fill needs Touch ID.",
  },
  {
    q: "Which Macs does it run on?",
    a: "macOS on Apple silicon. Builds are signed and notarized, and the app updates itself from its public release feed.",
  },
  {
    q: "Is it finished?",
    a: "No. It's in active development, and the changelog is the honest record of what has landed. Things move fast, and some parts of the app are newer than others.",
  },
]

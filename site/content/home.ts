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
/** A region of a capture, as fractions of it: the point to keep centred, and how much width to show. */
export type Focus = { x: number; y: number; span: number }

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
    title: "Every space, in one sidebar.",
    body:
      "Each space of a profile is a section of one list: its name in its colour, what is waiting and working in it, and its sessions. Above them, Needs you gathers every session waiting on a permission or a question — from every space and every profile — and a row unfolds that session's own card, so you can answer without going to it. Moving between spaces loads nothing, because every space is already loaded.",
    capture: "sidebar",
    /* The column, from the profile down: Needs you, then the spaces and their sessions. */
    focus: { x: 0.25, y: 0.27, span: 0.56 },
    caption: "Three sessions waiting on you — two questions and a sub-agent's permission, one from another profile — above every space's sessions.",
  },
  {
    id: "transcript",
    title: "A transcript you can read.",
    body:
      "A turn is not a wall of log. Tool calls fold into rows you can open, a plan renders as a plan, a reply can carry a chart, a diagram or a comparison, and a turn that changed files ends with a card: each file with its counts as git measured them, Review for that turn's diff, and Undo where a checkpoint takes back exactly that turn. A tick down the pane's edge marks every prompt, so a long log has a map.",
    capture: "session",
    /* The answer from its first line to the turn's card under it. */
    focus: { x: 0.5, y: 0.47, span: 0.75 },
    caption: "One turn: the answer, the files it named as links, and the two it edited, with Review and Undo.",
  },
  {
    id: "agents",
    title: "Bring the agent you already use.",
    body:
      "Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code and Grok all run here, most of them through one Agent Client Protocol adapter. Each keeps its own login, its own models and its own permission modes; the picker lists them by the harness a click runs them through, with each model's own effort levels and fast mode at its foot. Realm never asks for an API key — signing in runs the agent's own login, and approving it is your click.",
    capture: "models",
    /* The prompter and the whole picker under its chip, from the search to the effort track. */
    focus: { x: 0.615, y: 0.66, span: 0.77 },
    caption: "Every installed agent's models in one list: Opus 5.5 picked, at Max, with fast mode on.",
  },
  {
    id: "delegation",
    title: "Hand work to other models.",
    body:
      "Ask in words — have GPT-6 Luna build this — or pick models in a session's Agents tab and say what to build. The session's own agent splits the work, starts a sub-agent on each model through whichever harness runs it, waits for the reports and says what each one did. Each sub-agent is a line of its own in the transcript, a click from its own.",
    capture: "delegation",
    /* The lead's lines and the Agents tab beside them. */
    focus: { x: 0.615, y: 0.38, span: 0.77 },
    caption: "Two sub-agents on two harnesses: one finished with its report, one waiting on a permission.",
  },
  {
    id: "gateway",
    title: "Your tools, without your credentials.",
    body:
      "Linear, Notion, Slack, GitHub, Jira, Figma and Sentry connect in a click, signed in through the app itself. They belong to the space rather than to an agent, so every session in it reaches them through one Realm endpoint — and the agent is handed the tools, not the credential: it calls Realm, and Realm calls the server. Every proxied call is logged, with its arguments and what came back. Your own MCP servers go in the same place. An OAuth connection is encrypted under a key in the macOS Keychain; a key you paste into a custom server is not, and the app says so at the field where you type it.",
    capture: "connections",
    /* The page's head and the first two rows of cards, close enough to read what each one grants. */
    focus: { x: 0.51, y: 0.36, span: 0.7 },
    caption: "Connecting an app to a space. One click each, and every session in the space can use them.",
  },
  {
    id: "review",
    title: "Review pull requests without handing over GitHub.",
    body:
      "Code review lists your pull requests through your own gh, so Realm holds no GitHub token and sees exactly what gh sees. A request opens on its summary and its changes; a reviewer runs over the diff, held to read-only, on the model and level you choose, and leaves its findings on the page. None of them, nor any comment of yours, reaches GitHub until you press Submit review.",
    capture: "review",
    /* The request, the reviewer's findings and the facts beside them, clear of the column. */
    focus: { x: 0.62, y: 0.38, span: 0.76 },
    caption: "A request's summary with three findings from a reviewer, one on a line its diff does not show.",
  },
  {
    id: "sandbox",
    title: "Confine what an agent can touch.",
    body:
      "A space can put its agents and terminals behind a macOS Seatbelt policy: its checkouts and the toolchain caches writable, the files in your home that make something run later readable but not changeable, and credential folders unreadable. It confines the process and everything that process starts. Seatbelt is not a container and the network stays open — this limits what a session can damage or read, not what it can send. It ships off, per space, because a writable-root list that has not met your toolchain yet is a list that can break a build.",
    capture: "sandbox",
    /* The three posture cards, not the settings page they sit on. */
    focus: { x: 0.615, y: 0.41, span: 0.68 },
    caption: "The three postures a space can take, on the one it ships with.",
  },
  {
    id: "durable",
    title: "Work that outlives the window.",
    body:
      "realm-server keeps running when you close the window, so a long turn finishes whether or not you are watching. A task can run on a clock — each run a real session you can read and carry on — every turn is bracketed by a workspace checkpoint, and restoring one puts the files back and, for Claude, rewinds the conversation with them.",
    capture: "schedules",
    /* The whole width: the column of tasks, the run and the task's card are one picture. */
    focus: { x: 0.5, y: 0.43, span: 1 },
    caption: "Three tasks, each on its own model, and a run open as its own session beside the task's card.",
  },
]

export type Facet = { title: string; body: string }

/**
 * What a realm is made of — the six faces of the mark, in the order they arrive (`ORDER` in
 * lib/dimension/faces.ts), so the sentence beside a face is about the face that is landing.
 *
 * A realm is a place rather than a stack of layers, so these are what the place contains — each one
 * something the shipped app does, with the limit stated wherever there is one.
 */
export const facets: Facet[] = [
  {
    title: "The agent",
    body: "Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code or Grok, each on its own login, models and permission modes. Realm never asks for an API key.",
  },
  {
    title: "The checkout",
    body: "A space is pointed at your code \u2014 one checkout or several \u2014 and its sessions work there. Each turn is bracketed by a checkpoint, and restoring one puts the files back.",
  },
  {
    title: "The terminal",
    body: "Real terminals beside the agent — and the agent can read what one is showing, the rendered screen rather than a raw tail, and answer a prompt waiting in it.",
  },
  {
    title: "The browser",
    body: "A browser pane that stays signed in, which an agent can read and drive. It stops at a consent screen: approving a sign-in stays yours unless a space says otherwise.",
  },
  {
    title: "The tools",
    body: "Linear, GitHub, Slack, Notion and your own MCP servers, through one gateway per space. The agent is handed the tools, never the credentials, and every call is logged.",
  },
  {
    title: "The boundary",
    body: "A macOS sandbox a space can put its agents behind: the checkout writable, credential folders unreadable. It ships off, per space, because one that has not met your toolchain yet can break a build.",
  },
]

/** The eighth step, when the view pulls back and the realm is one of many. */
export const facetsMany: Facet = {
  title: "One for every project, all at once.",
  body: "Spaces sit side by side, each with its own agents at work, and none reaches another\u2019s tools. The Agents page reads every one of them at once \u2014 a wall of tiles, or an office with a figure at every desk \u2014 and the sidebar keeps every chat across them, by the day you last worked on it.",
}

/** The seventh step, when all six are in. */
export const facetsCoda: Facet = {
  title: "That\u2019s a realm.",
  body: "Open one for every project. They run side by side, none of them reaches another\u2019s tools, and each is where you left it when you come back.",
}

/**
 * The interlude between the claims: delegation, told in the order the tree draws it
 * (lib/dimension/tree.ts). Every sentence is the delegation code's own behaviour — `agent_run` and
 * `agent_start`, `MAX_DELEGATION_DEPTH`, the fenced final report — and `realm-agent` is on by
 * default, so "an agent can" is true of a fresh install rather than of a setting.
 */
export const delegation: Facet[] = [
  {
    title: "One agent can open more.",
    body: "An agent in Realm can hand work to other agents. Each one is a real session in the space \u2014 a pane you can open and watch while it works.",
  },
  {
    title: "Several at once.",
    body: "Independent tasks run in parallel, each in the space\u2019s checkout, a named environment or a fresh worktree of its own. Their permission prompts come to their own panes, and none of them inherits a bypass.",
  },
  {
    title: "Two levels, and no further.",
    body: "A sub-agent may delegate once more. Past that it is refused, because every level is another agent someone has to follow.",
  },
  {
    title: "Everything comes back.",
    body: "Each one returns a final report to the call that sent it. Its full trace stays in its own pane, and in the transcript it nests under the call that spawned it.",
  },
]

export type Question = { q: string; a: string }

/**
 * Answers, not reassurance. Each one states the limit as plainly as the capability — a FAQ that only
 * says yes is an advertisement with a different shape.
 */
export const faq: Question[] = [
  {
    q: "Which agents can I run?",
    a: "Claude Code and Codex have their own adapters; Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code, Grok and others speak the Agent Client Protocol and share one. Claude needs no install, because Realm carries Claude Code; Codex installs and signs in from first run; the rest you install yourself, and Realm probes for what is on the machine and tells you the exact install or login command for what is not.",
  },
  {
    q: "Do I need an API key?",
    a: "No. Realm drives the CLI you already have, on whatever plan or key you already pay for. It never proxies a provider's traffic and never asks for a key.",
  },
  {
    q: "Where does my work live?",
    a: "On your Mac, under ~/Realm. Transcripts, documents, skills and checkpoints are files and a SQLite database on disk. Nothing is uploaded, and there is no account to make.",
  },
  {
    q: "Can an agent read my tokens?",
    a: "Not through the gateway: connections are proxied per space, so the agent calls Realm and Realm calls the server, and the credential stays on Realm's side of that hop. At rest, be specific — an app you connect in a click stores an OAuth token encrypted under a macOS Keychain key, but a key or header you paste into a custom MCP server is stored in Realm's database in plain text, and the app says so at the field where you enter it. Saved website sign-ins are the strict case: encrypted, never handed to an agent, and every fill needs Touch ID.",
  },
  {
    q: "Which Macs does it run on?",
    a: "macOS on Apple silicon. Builds are signed and notarized, and the app updates itself from its public release feed.",
  },
  {
    q: "Is it finished?",
    a: "No — it is in active development, and the changelog is the honest record of what has landed. Things move quickly and some surfaces are newer than others.",
  },
]

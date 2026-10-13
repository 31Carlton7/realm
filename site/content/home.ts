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
export type Claim = {
  /** Stable id, used for the section's own heading anchor. */
  id: string
  title: string
  body: string
  /** A slug in the capture manifest, or null for a claim that has no picture yet. */
  capture: string | null
  /**
   * The part of that scene the claim is about, photographed on its own (`public/product/parts.json`,
   * written by `scripts/capture-product.mjs`).
   *
   * Every scene is shot at the whole 1440x900 window, and most of them spend a good half of it on
   * the sidebar and empty canvas either side of the thing being claimed: shown whole in a page column
   * the subject lands around half its own size, a picture of the product rather than a readable one.
   * A part is the one surface the claim is about, at the size it has in the app. A claim without one
   * shows its whole scene.
   */
  part?: string
  /** What the picture shows. Required wherever there is one, and re-read whenever it is retaken. */
  caption?: string
}

export const claims: Claim[] = [
  {
    id: "spaces",
    title: "Every space in one sidebar.",
    body:
      "Each space gets its own section, with a count of what's waiting and working. Needs you sits on top and collects every session waiting on you, from every space and every profile.",
    capture: "sidebar",
    part: "sidebar",
    caption: "Two questions waiting on you, above every space.",
  },
  {
    id: "transcript",
    title: "A transcript you can read.",
    body:
      "Tool calls fold into rows you can open, and a reply can carry a chart, a diagram or a comparison. A turn that changes files ends with a card of each file it edited, its diff a click away.",
    capture: "session",
    part: "turn",
    caption: "One turn: the ask, its tool calls in one row, the answer, and the two files it edited.",
  },
  {
    id: "agents",
    title: "Bring the agent you already use.",
    body:
      "Each one keeps its own login, models and permission modes, and Realm never asks for an API key.",
    capture: "models",
    part: "models",
    caption: "Claude's and Codex's models in one picker, with Opus\u00a05.5 at Max and fast mode on.",
  },
  {
    id: "delegation",
    title: "Hand work to other models.",
    body:
      "Ask in plain words, like “have GPT-6 Luna build this”, or pick models in the session's Agents tab. The session's agent splits up the work and starts a sub-agent on each model.",
    capture: "delegation",
    part: "delegation",
    caption: "Two sub-agents on two harnesses: one waiting on a permission, one done with its report.",
  },
  {
    id: "gateway",
    title: "Your tools, without your credentials.",
    body:
      "Linear, Notion, Slack, GitHub, Jira, Figma and Sentry connect to a space in one click. Agents reach them through Realm and never get the credential, and every call is logged.",
    capture: "connections",
    part: "connections",
    caption: "Six of the apps a space can connect, each with what it lets an agent do.",
  },
  {
    id: "review",
    title: "Review pull requests without handing over GitHub.",
    body:
      "Code review reads your pull requests through your own gh, so Realm never holds a GitHub token. A reviewer on the model you pick leaves its findings on the page, and nothing reaches GitHub until you press Submit review.",
    capture: "review",
    part: "review",
    caption: "A pull request and three findings from a reviewer on Fable\u00a05.1.",
  },
  {
    id: "sandbox",
    title: "Confine what an agent can touch.",
    body:
      "A space can run its agents and terminals in a macOS sandbox, where the checkout stays writable and credential folders can't be read. The network stays open, and it's off by default, because a sandbox that hasn't met your toolchain yet can break a build.",
    capture: "sandbox",
    part: "sandbox",
    caption: "The three postures a space can take. Every new space starts on No sandbox.",
  },
  {
    id: "durable",
    title: "Work that outlives the window.",
    body:
      "realm-server keeps running after you close the window, so a long turn finishes either way. Tasks can run on a schedule, and every run is a session you can pick up from.",
    capture: "schedules",
    part: "schedules",
    caption: "Three tasks on a schedule, each on its own model, and today's run of Weekly numbers.",
  },
]

export type Facet = { title: string; body: string }

/**
 * What a realm is made of: the six faces of the mark, the walls first and the agent last, as the
 * doorway's lit back.
 *
 * A realm is a place rather than a stack of layers, so these are what the place contains, each one
 * something the shipped app does, with the limit stated wherever there is one.
 */
export const facets: Facet[] = [
  {
    title: "The checkout",
    body: "Your code, one checkout or several, with a checkpoint at every turn.",
  },
  {
    title: "The terminal",
    body: "Real terminals beside the agent, which it can read and answer.",
  },
  {
    title: "The browser",
    body: "A browser that stays signed in, for agents to read and drive. It stops at a consent screen.",
  },
  {
    title: "The tools",
    body: "Linear, GitHub, Slack, Notion and your own MCP servers. Agents get the tools, never the credentials.",
  },
  {
    title: "The boundary",
    body: "A macOS sandbox that keeps credential folders unreadable. It's off by default.",
  },
  {
    title: "The agent",
    body: "Claude Code, Codex, Cursor, Gemini and more, each with its own login and models.",
  },
]

/** What the six come to. */
export const facetsCoda: Facet = {
  title: "That's a realm.",
  body: "Make one for every project. None can reach another's tools, and each is right where you left it.",
}

/**
 * Delegation, beat by beat, beside its chapter's picture. Every sentence is the delegation code's own
 * behaviour (`agent_run` and `agent_start`, `MAX_DELEGATION_DEPTH`, the fenced final report), and
 * `realm-agent` is on by default, so "an agent can" is true of a fresh install rather than of a setting.
 */
export const delegation: Facet[] = [
  {
    title: "One agent can start more.",
    body: "Each sub-agent is a real session in the space, so you can open it and watch it work.",
  },
  {
    title: "Several at once.",
    body: "Independent tasks run in parallel, and every sub-agent asks for permission like any other session.",
  },
  {
    title: "Two levels deep, and that's it.",
    body: "A sub-agent can hand work off once more. Past that, Realm says no.",
  },
  {
    title: "Everything comes back.",
    body: "Each sub-agent sends a final report to the agent that started it.",
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

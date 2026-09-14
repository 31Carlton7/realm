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
  /** What the picture is evidence OF. Required wherever there is one. */
  caption?: string
}

export const claims: Claim[] = [
  {
    id: "transcript",
    title: "A transcript you can read.",
    body:
      "A turn is not a wall of log. Tool calls fold into rows you can open, a plan renders as a plan, a diff as a diff, and sub-agents nest under the call that spawned them. What the agent did stays legible weeks later, which is the difference between a record and a receipt.",
    capture: "session",
    caption: "One turn: the reply, the plan it wrote, and the calls it made, each openable.",
  },
  {
    id: "agents",
    title: "Bring the agent you already use.",
    body:
      "Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code and Grok all run here, most of them through one Agent Client Protocol adapter. Each keeps its own login, its own models and its own permission modes. Realm never asks for an API key and never handles a provider's sign-in — you install each CLI and log in to it yourself.",
    capture: "models",
    caption: "Every model the installed agents advertise, in one picker, grouped by the harness that offers it.",
  },
  {
    id: "gateway",
    title: "Your tools, without your credentials.",
    body:
      "Linear, Notion, Slack, GitHub, Jira, Figma and Sentry connect in a click, signed in through the app itself. They belong to the space rather than to an agent, so every session in it reaches them through one Realm endpoint — and the agent is handed the tools, not the credential: it calls Realm, and Realm calls the server. Every proxied call is logged, with its arguments and what came back. Your own MCP servers go in the same place. An OAuth connection is encrypted under a key in the macOS Keychain; a key you paste into a custom server is not, and the app says so at the field where you type it.",
    capture: "connections",
    caption: "Connecting an app to a space. One click each, and every session in the space can use them.",
  },
  {
    id: "sandbox",
    title: "Confine what an agent can touch.",
    body:
      "A space can put its agents and terminals behind a macOS Seatbelt policy: its checkouts and the toolchain caches writable, the files in your home that make something run later readable but not changeable, and credential folders unreadable. It confines the process and everything that process starts. Seatbelt is not a container and the network stays open — this limits what a session can damage or read, not what it can send. It ships off, per space, because a writable-root list that has not met your toolchain yet is a list that can break a build.",
    capture: "sandbox",
    caption: "The three postures a space can take, on the one it ships with.",
  },
  {
    id: "durable",
    title: "Work that outlives the window.",
    body:
      "realm-server keeps running when you close the window, so a long turn finishes whether or not you are watching. Runs can be scheduled, every turn is bracketed by a workspace checkpoint, and restoring one puts the files back — and, for Claude, rewinds the conversation with them.",
    capture: "schedules",
    caption: "Two schedules in one space: what each one asks for, when it next runs, and the switch that pauses it.",
  },
  {
    id: "recall",
    title: "Find anything you have done.",
    body:
      "One search reaches transcripts, open items, skills and memory across a whole profile. The sidebar keeps every chat you have, across spaces, grouped by the day you last worked on it and labelled with the space it belongs to — plus the folder and the branch on the rows where those say something the space name does not.",
    capture: "activity",
    caption: "Every chat in the profile, by the day it was last worked on.",
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
    a: "Claude Code and Codex have their own adapters; Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code, Grok and others speak the Agent Client Protocol and share one. You install each CLI and sign in to it yourself — Realm probes for what is on the machine and tells you the exact install or login command for what is not.",
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

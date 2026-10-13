import type { AgentId } from "@/components/AgentMark"
import type { MiniScene } from "@/components/home/mini/MiniRealm"
import { features } from "@/content/features"

/**
 * What the Inside page says, chapter by chapter, and what the window does while it says it.
 *
 * Every sentence is the landing page's own copy (content/home.ts), the features page's
 * (content/features.ts) or the changelog's, shortened where a chapter has less room than a section
 * had. Nothing here is new about Realm; what is new is which part of the window each sentence is
 * about, which is what the camera and the callout show.
 *
 * A chapter is one or more beats. A beat is one framing of the window: the working sample in one of
 * its states, or a capture of the shipped app shown in the same frame, and the part of it the camera
 * frames. Rects are fractions of the window, so the same beat frames the same part at any size.
 */

/** left, top, width, height — fractions of whatever they are measured against. */
export type Frac = readonly [number, number, number, number]

export type Beat = {
  /** What the frame shows: the sample, put in this state, or the capture with this slug. */
  scene?: MiniScene
  capture?: string
  /** Where in the window the camera looks, before the sample has been measured. */
  focus: Frac
  /** The sample's own element the camera frames once it can be measured, and the part of it. */
  target?: { selector: string; part?: Frac }
  /** The largest the camera magnifies this beat. */
  zoom?: number
  /** A sentence for this beat alone, under the chapter's body. */
  line?: string
}

export type Chapter = {
  id: string
  /** Its name on the timeline. */
  short: string
  title: string
  body: string
  /** The claim whose caption describes the capture, when a beat shows one. */
  claim?: string
  /** What to do in the window, where the sample answers. */
  try?: string
  marks?: AgentId[]
  beats: Beat[]
}

const SPACES = 'nav[aria-label="Spaces"]'
const SESSION = 'section[aria-label^="Session"]'
const PANEL = 'aside[aria-label="Side panel"]'

/** The sample's columns at full width, as fractions of the window: the camera's framing before the
 *  sample can be measured, and exact wherever the window is wide enough to show all three. */
const COLUMNS: Record<string, Frac> = {
  [SPACES]: [0.04, 0, 0.2067, 1],
  [SESSION]: [0.2467, 0, 0.42, 1],
  [PANEL]: [0.6667, 0, 0.3333, 1],
}

/** A beat that frames part of one of the sample's columns. */
const on = (selector: string, part: Frac = [0, 0, 1, 1]): Pick<Beat, "focus" | "target"> => {
  const [x, y, w, h] = COLUMNS[selector]!
  return { focus: [x + part[0] * w, y + part[1] * h, part[2] * w, part[3] * h], target: { selector, part } }
}

/** The window's own states, as the row under the sample names them. */
const CRASH: MiniScene = { session: "crash", tab: "crash-doc", view: "session" }

export const chapters: Chapter[] = [
  {
    id: "spaces",
    short: "Spaces",
    title: "Every space in one sidebar.",
    body: "Each space gets its own section: its name in its colour, a count of what's waiting and working, and its sessions. Switching spaces loads nothing, because they're all loaded already.",
    beats: [{ scene: CRASH, ...on(SPACES, [0, 0, 1, 0.82]), zoom: 1.3 }],
  },
  {
    id: "needs-you",
    short: "Needs you",
    title: "What's waiting on you, from every space.",
    body: "Needs you sits on top and collects every session waiting on a permission or a question, from every space and every profile. Open a row and answer it right there. Answering in one place clears it everywhere.",
    try: "Pick a layout in the card.",
    beats: [
      {
        scene: { session: "settings", view: "sidebar", expand: "settings" },
        focus: [0.045, 0.06, 0.2, 0.45],
        target: { selector: `${SPACES} li:has(> [aria-expanded="true"])` },
        zoom: 1.5,
      },
    ],
  },
  {
    id: "transcript",
    short: "Transcript",
    title: "A transcript you can read.",
    body: "A turn isn't a wall of log. Tool calls fold into rows you can open, and when a turn changes files, it ends with a card listing each file and its line counts from git.",
    beats: [
      { scene: CRASH, ...on(SESSION, [0, 0.07, 1, 0.74]), zoom: 1.25 },
      {
        scene: { session: "crash", tab: "crash-diff", view: "panel" },
        ...on(PANEL, [0, 0, 1, 0.62]),
        zoom: 1.3,
        line: "Review opens that turn's diff beside it, and Undo is there when a checkpoint can take back exactly that turn.",
      },
    ],
  },
  {
    id: "side-panel",
    short: "Side panel",
    title: "What an agent opens lands beside the session.",
    body: "A document, a terminal or a browser that an agent opens shows up as a tab in the side panel, next to the session that opened it, instead of a new column squeezed in next to whatever had focus.",
    beats: [
      {
        scene: { session: "crash", tab: "crash-doc", view: "panel" },
        ...on(PANEL, [0, 0, 1, 0.66]),
        zoom: 1.3,
        line: "When the agent names a file, it opens there at the line it named.",
      },
      {
        scene: { session: "tests", tab: "tests-term", view: "panel" },
        ...on(PANEL, [0, 0, 1, 0.6]),
        zoom: 1.3,
        line: "Real terminals next to the agent, which reads what a terminal is showing on screen, not a raw log.",
      },
      {
        scene: { session: "settings", tab: "settings-browser", view: "panel" },
        ...on(PANEL, [0, 0, 1, 0.7]),
        zoom: 1.25,
        line: "A browser that stays signed in, which agents can read and drive. It stops at a consent screen.",
      },
    ],
  },
  {
    id: "delegation",
    short: "Sub-agents",
    title: "Hand work to other models.",
    body: "Ask in plain words (“have GPT-6 Luna build this”) or pick models in the session's Agents tab. The session's agent starts a sub-agent on each model, through whichever harness runs it, and waits for the reports.",
    beats: [
      {
        scene: { session: "dark", tab: "dark-agents", view: "panel" },
        ...on(SESSION, [0, 0.04, 1, 0.5]),
        zoom: 1.3,
        line: "Every sub-agent gets its own line in the transcript, and its own session is a click away.",
      },
      {
        scene: { session: "dark", tab: "dark-agents", view: "panel" },
        ...on(PANEL, [0, 0, 1, 0.62]),
        zoom: 1.3,
        line: "A sub-agent can hand work off once more. Past that, Realm says no: two levels deep, and that's it.",
      },
    ],
  },
  {
    id: "agents",
    short: "Agents",
    title: "Bring the agent you already use.",
    body: "Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code and Grok all run here, each with its own login, models and permission modes. Realm never asks for an API key.",
    claim: "agents",
    marks: ["claude", "openai", "cursor", "gemini", "opencode", "githubCopilot", "goose", "qwen", "grok"],
    beats: [{ capture: "models", focus: [0.37, 0.33, 0.5, 0.67], zoom: 1.25 }],
  },
  {
    id: "gateway",
    short: "Connections",
    title: "Your tools, without your credentials.",
    body: "Linear, Notion, Slack, GitHub, Jira, Figma and Sentry connect in one click. A connection belongs to the space: the agent calls Realm, Realm calls the server, and the agent never gets the credential. Every call is logged.",
    claim: "gateway",
    beats: [{ capture: "connections", focus: [0.265, 0.06, 0.5, 0.8], zoom: 1.2 }],
  },
  {
    id: "sandbox",
    short: "Sandbox",
    title: "Confine what an agent can touch.",
    body: "A space can run its agents and terminals inside a macOS Seatbelt policy: checkouts stay writable and credential folders can't be read. The network stays open, so it limits what a session can damage or read, not what it can send. Off by default, per space.",
    claim: "sandbox",
    beats: [{ capture: "sandbox", focus: [0.36, 0.06, 0.51, 0.62], zoom: 1.25 }],
  },
  {
    id: "review",
    short: "Review",
    title: "Review pull requests without handing over GitHub.",
    body: "Code review lists your pull requests through your own gh, so Realm never holds a GitHub token. A reviewer reads the diff in read-only mode on the model you pick, and nothing reaches GitHub until you press Submit review.",
    claim: "review",
    beats: [{ capture: "review", focus: [0.25, 0.1, 0.52, 0.6], zoom: 1.25 }],
  },
  {
    id: "durable",
    short: "Schedules",
    title: "Work that outlives the window.",
    body: "realm-server keeps running after you close the window, so a long turn finishes whether you're watching or not. Each turn is bracketed by a checkpoint, and restoring one puts the files back.",
    claim: "durable",
    beats: [
      {
        scene: { session: "weekly", view: "session" },
        ...on(SESSION, [0, 0.04, 1, 0.6]),
        zoom: 1.3,
        line: "Tasks run on a schedule, and every run is a real session you can read and pick up from.",
      },
      { capture: "schedules", focus: [0.035, 0.05, 0.93, 0.9], zoom: 0.9 },
    ],
  },
]

/**
 * The rest of the evidence, run past the camera once the chapters are done: each capture cut to what
 * its caption is about, the centre of the cut and how much of the window's width it shows. The frame
 * is the window's own 16:10, so the cut shows the same share of its height.
 */
const STRIP: [slug: string, cx: number, cy: number, span: number][] = [
  ["splits", 0.62, 0.36, 0.62],
  ["questions", 0.6, 0.36, 0.52],
  ["blocks", 0.6, 0.33, 0.5],
  ["palette", 0.5, 0.39, 0.44],
  ["library", 0.62, 0.48, 0.74],
  ["memory", 0.61, 0.3, 0.52],
  ["profiles", 0.16, 0.22, 0.4],
  ["onboarding", 0.5, 0.5, 0.5],
]

export type Still = { slug: string; title: string; blurb: string; cut: readonly [number, number, number] }

export const stills: Still[] = STRIP.flatMap(([slug, cx, cy, span]) => {
  const feature = features.find((f) => f.slug === slug)
  return feature ? [{ slug, title: feature.title, blurb: feature.blurb, cut: [cx, cy, span] as const }] : []
})

/** Where a cut's picture sits in its frame: its size and offset, as fractions of the frame. */
export const cutStyle = ([cx, cy, span]: readonly [number, number, number]) => {
  const x = Math.min(Math.max(cx - span / 2, 0), 1 - span)
  const y = Math.min(Math.max(cy - span / 2, 0), 1 - span)
  return { width: `${100 / span}%`, left: `${(-x / span) * 100}%`, top: `${(-y / span) * 100}%` }
}

/** The window the sample is drawn at before the camera scales it: a 16:10 Mac window. */
export const WINDOW = { width: 1200, height: 750, radius: 16 } as const

export const captureSrc = (slug: string, width: 1440 | 4320) => `/product/${slug}-${width}.webp`

import type { AgentId } from "@/components/AgentMark"

/**
 * The agents Realm runs, in the order the page names them, and where each one's mark sits around the
 * hero on a wide screen: which side of the words, how far out from the column they are set in (`dx`),
 * and how high above the product window (`dy`), both in CSS px. `land` is where its stream meets the
 * window's top edge, as a fraction of the window's width in from that side's corner.
 *
 * The two arcs are ordered so the streams never cross: the higher a mark sits, the further in its
 * stream lands.
 */
export type StreamAgent = {
  id: AgentId
  name: string
  side: "left" | "right"
  dx: number
  dy: number
  land: number
}

export const AGENTS: readonly StreamAgent[] = [
  { id: "claude", name: "Claude Code", side: "left", dx: 44, dy: 356, land: 0.275 },
  { id: "openai", name: "Codex", side: "left", dx: 96, dy: 282, land: 0.25 },
  { id: "cursor", name: "Cursor", side: "left", dx: 122, dy: 208, land: 0.225 },
  { id: "gemini", name: "Gemini", side: "left", dx: 122, dy: 136, land: 0.2 },
  { id: "opencode", name: "OpenCode", side: "left", dx: 98, dy: 66, land: 0.175 },
  { id: "githubCopilot", name: "GitHub Copilot", side: "right", dx: 70, dy: 320, land: 0.26 },
  { id: "goose", name: "goose", side: "right", dx: 114, dy: 244, land: 0.235 },
  { id: "qwen", name: "Qwen Code", side: "right", dx: 126, dy: 168, land: 0.21 },
  { id: "grok", name: "Grok", side: "right", dx: 106, dy: 94, land: 0.185 },
]

export const STREAM_COUNT = AGENTS.length

/** Half the width of the column the words are set in on a wide screen; the arcs are measured from its edges. */
export const COLUMN_HALF_REM = 24

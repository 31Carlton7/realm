"use client"

import { useRef } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"
import { Icon } from "@/components/home/mini/icons"
import type { Claim, Facet } from "@/content/home"

import { useAnchors } from "../kit/anchors"
import { Chapter, Evidence, Instrument } from "../kit/Chapter"
import { useScrollProgress } from "../kit/hooks"
import { span } from "../kit/math"
import { route, slice, type Pt, type Route } from "../kit/route"
import { Signal, SignalDefs } from "../kit/signal"

type Node = {
  id: string
  level: 0 | 1 | 2
  /** Across the drawing, 0..1. */
  x: number
  parent: string | null
  agent: AgentId
  model: string
  task: string
  /** When, in the scroll, its branch draws: from, to. */
  grows: [number, number]
  /** When its report travels back up: from, to. */
  reports: [number, number]
}

/**
 * A sample tree. The models are ones the page shows elsewhere; the tasks are a sample's. What it
 * claims is the delegation code's own behaviour: several at once, two levels, a third refused, and
 * every report back to the agent that asked.
 */
const NODES: Node[] = [
  { id: "lead", level: 0, x: 0.5, parent: null, agent: "claude", model: "Opus 5.5", task: "Dark mode, end to end", grows: [0, 0], reports: [1, 1] },
  { id: "luna", level: 1, x: 0.16, parent: "lead", agent: "openai", model: "GPT-6 Luna", task: "The toggle and its tests", grows: [0.04, 0.17], reports: [0.82, 0.93] },
  { id: "fable", level: 1, x: 0.5, parent: "lead", agent: "claude", model: "Fable 5.1", task: "Storing the choice", grows: [0.25, 0.38], reports: [0.84, 0.95] },
  { id: "sonnet", level: 1, x: 0.84, parent: "lead", agent: "claude", model: "Sonnet 5", task: "The settings copy", grows: [0.25, 0.38], reports: [0.8, 0.91] },
  { id: "haiku", level: 2, x: 0.36, parent: "fable", agent: "claude", model: "Haiku 4.5", task: "The migration's fixtures", grows: [0.47, 0.57], reports: [0.71, 0.8] },
  { id: "luna2", level: 2, x: 0.64, parent: "fable", agent: "openai", model: "GPT-6 Luna", task: "The schema check", grows: [0.47, 0.57], reports: [0.73, 0.82] },
]
/** The third level, refused: out of a level-two node, into the boundary, and no further. */
const REFUSED = { from: "luna2", grows: [0.59, 0.66] as [number, number] }

const BEATS: [number, number][] = [
  [0, 0.22],
  [0.22, 0.45],
  [0.45, 0.7],
  [0.7, 1.01],
]

const H = 540
const LEVEL_Y = [44, 196, 348]
const BOUNDARY_Y = 462

export function Delegation({ beats, claim }: { beats: Facet[]; claim: Claim }) {
  const drawingRef = useRef<HTMLDivElement>(null)
  const progress = useScrollProgress(drawingRef, { from: 0.82, to: 0.12 })
  const beat = BEATS.findIndex(([a, b]) => progress >= a && progress < b)

  return (
    <Chapter
      id="delegation"
      title="Hand work to other models."
      instrument={
        <Instrument kind="Diagram" caption="One session's sub-agents, drawn as you scroll. A sample tree.">
          <div ref={drawingRef}>
            <Tree progress={progress} />
          </div>
        </Instrument>
      }
      evidence={<Evidence claim={claim} />}
    >
      <p>
        Ask in plain words (&ldquo;have GPT-6 Luna build this&rdquo;) or pick models in a session&rsquo;s Agents tab. The
        session&rsquo;s agent splits up the work, starts a sub-agent on each model through whichever harness runs it, and
        tells you what each one did.
      </p>
      <ol className="mt-8 space-y-5 border-l border-line">
        {beats.map((b, i) => {
          const on = beat === i
          return (
            <li key={b.title} className="relative pl-5">
              <span
                aria-hidden
                className={`absolute top-[5px] -left-px h-[calc(100%-6px)] w-px transition-colors duration-300 ${on ? "bg-accent" : i < beat ? "bg-[oklch(1_0_0/0.3)]" : "bg-transparent"}`}
              />
              <p className={`text-[15px] font-[540] transition-colors duration-300 ${on ? "text-ink" : "text-ink-2"}`}>{b.title}</p>
              <p className="mt-1 text-[14.5px] leading-[1.55] text-ink-2">{b.body}</p>
            </li>
          )
        })}
      </ol>
    </Chapter>
  )
}

function Tree({ progress: p }: { progress: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const { width } = useAnchors(ref)
  const narrow = width < 560
  const W = width || 800
  const left = narrow ? 8 : 112
  const usable = W - left - (narrow ? 8 : 24)
  const at = (n: Node): Pt => [left + usable * n.x, LEVEL_Y[n.level]!]
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]))

  const branches: { node: Node; r: Route }[] = NODES.filter((n) => n.parent).map((n) => {
    const from = at(byId[n.parent!]!)
    const to = at(n)
    const mid = from[1] + (to[1] - from[1]) * 0.5
    const pts: Pt[] = Math.abs(from[0] - to[0]) < 1 ? [[from[0], from[1] + 13], [to[0], to[1] - 13]] : [[from[0], from[1] + 13], [from[0], mid], [to[0], mid], [to[0], to[1] - 13]]
    return { node: n, r: route(pts, 12) }
  })
  const refusedFrom = at(byId[REFUSED.from]!)
  const refused = route([[refusedFrom[0], refusedFrom[1] + 13], [refusedFrom[0], BOUNDARY_Y]], 12)
  const refusedK = span(p, ...REFUSED.grows)

  const shown = (n: Node) => n.level === 0 || p >= n.grows[1] - 0.005
  const state = (n: Node): "working" | "done" | "idle" => {
    if (!shown(n)) return "idle"
    if (n.level === 0) return p >= 0.97 ? "done" : "working"
    return p >= n.reports[1] ? "done" : "working"
  }
  const reported = NODES.filter((n) => n.level === 1 && p >= n.reports[1]).length

  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" fill="none">
        <SignalDefs id="tree" />
        {/* The levels, ruled across; the third is a wall. */}
        {LEVEL_Y.map((y, i) => (
          <path key={y} d={`M0 ${y}H${W}`} stroke="oklch(1 0 0 / 0.07)" strokeDasharray={i === 0 ? undefined : "2 5"} />
        ))}
        <path d={`M0 ${BOUNDARY_Y}H${W}`} stroke={refusedK >= 1 ? "oklch(0.666 0.18 21.433 / 0.7)" : "oklch(1 0 0 / 0.32)"} strokeWidth={1} className="transition-[stroke] duration-300" />

        {branches.map(({ node, r }) => {
          const k = span(p, ...node.grows)
          if (k <= 0) return null
          return <path key={node.id} d={k >= 1 ? r.d : slice(r, 0, r.length * k)} stroke="oklch(1 0 0 / 0.42)" strokeWidth={1} />
        })}
        {/* The growing tip of each branch carries the task down. */}
        {branches.map(({ node, r }) => {
          const k = span(p, ...node.grows)
          if (k <= 0 || k >= 1) return null
          return <Signal key={`${node.id}-task`} defs="tree" route={r} s={r.length * k} tail={36} />
        })}
        {/* The refused third level: drawn to the wall and stopped there. */}
        {refusedK > 0 ? (
          <>
            <path d={slice(refused, 0, refused.length * refusedK)} stroke="oklch(1 0 0 / 0.42)" strokeDasharray="3 4" />
            {refusedK < 1 ? <Signal defs="tree" route={refused} s={refused.length * refusedK} tail={30} /> : null}
            {refusedK >= 1 ? (
              <path
                d={`M${refusedFrom[0] - 5} ${BOUNDARY_Y - 5}L${refusedFrom[0] + 5} ${BOUNDARY_Y + 5}M${refusedFrom[0] + 5} ${BOUNDARY_Y - 5}L${refusedFrom[0] - 5} ${BOUNDARY_Y + 5}`}
                stroke="var(--color-red)"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            ) : null}
          </>
        ) : null}
        {/* Reports, back up the branch they came down. */}
        {branches.map(({ node, r }) => {
          const k = span(p, ...node.reports)
          if (k <= 0 || k >= 1) return null
          return <Signal key={`${node.id}-report`} defs="tree" route={r} s={r.length * (1 - k)} dir={-1} tail={36} />
        })}

        {NODES.map((n) => {
          if (!shown(n)) return null
          const [x, y] = at(n)
          const s = state(n)
          return (
            <g key={n.id}>
              <circle cx={x} cy={y} r={13} fill="var(--color-page)" stroke={s === "working" ? "var(--color-green)" : "oklch(1 0 0 / 0.35)"} />
              {s === "working" ? (
                <circle cx={x} cy={y} r={13} stroke="var(--color-green)" strokeWidth={1.6} strokeLinecap="round" strokeDasharray={`${(Math.PI * 26) / 5} ${Math.PI * 26}`} className="live-spin" />
              ) : null}
              {n.level === 0 && reported ? (
                <circle cx={x} cy={y} r={17.5} stroke="var(--color-accent)" strokeDasharray={`${(Math.PI * 35 * reported) / 3 - 3} 999`} transform={`rotate(-90 ${x} ${y})`} />
              ) : null}
            </g>
          )
        })}
      </svg>

      {/* Level names, at the left edge. */}
      {!narrow
        ? ["Your session", "Level one", "Level two"].map((label, i) => (
            <span key={label} style={{ top: LEVEL_Y[i]! - 22 }} className="absolute left-0 text-[12px] text-ink-2">
              {label}
            </span>
          ))
        : null}
      <span style={{ top: BOUNDARY_Y + 10 }} className={`absolute left-0 text-[12.5px] transition-colors duration-300 ${refusedK >= 1 ? "text-red" : "text-ink-3"}`}>
        A third level: Realm says no
      </span>

      {NODES.map((n) => {
        if (!shown(n)) return null
        const [x, y] = at(n)
        const below = n.level > 0
        return (
          <div key={n.id}>
            <span aria-hidden style={{ left: x, top: y }} className="absolute grid size-[26px] -translate-x-1/2 -translate-y-1/2 place-items-center text-ink">
              <AgentMark id={n.agent} className="size-3.5" />
            </span>
            <div
              style={below ? { left: x, top: y + 20 } : { left: x + 26, top: y }}
              className={`absolute w-max max-w-[11rem] ${below ? "-translate-x-1/2 text-center" : "-translate-y-1/2 text-left"}`}
            >
              <p className={`flex items-center gap-1 text-[12.5px] leading-[1.35] text-ink ${below ? "justify-center" : ""}`}>
                {n.model}
                {n.level > 0 ? (
                  <span title="Opens in your session's mode" className="text-ink-3">
                    <Icon name="shield" className="h-3 w-3" />
                  </span>
                ) : null}
              </p>
              <p className={`text-[12px] leading-[1.35] text-ink-3 ${narrow && n.level > 0 ? "hidden" : ""}`}>{n.task}</p>
              {n.level === 0 ? (
                <p className="mt-1 inline-flex items-center gap-1 text-[12px] text-ink-2">
                  <Icon name="shield" className="h-3 w-3" /> Ask each time
                  {reported ? <span className="ml-1 font-mono text-[11.5px] text-accent-ink">{reported}/3 back</span> : null}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
      <p className="absolute right-0 bottom-0 left-0 text-[12.5px] leading-[1.5] text-ink-2">
        <Icon name="shield" className="mr-1 inline h-3 w-3 -translate-y-px" />
        Every sub-agent opens in your session&rsquo;s mode, and asks for permission like any other session.
      </p>
    </div>
  )
}

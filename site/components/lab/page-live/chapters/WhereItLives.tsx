"use client"

import { useRef, useState, type ReactNode } from "react"

import { AgentMark, ToolMark } from "@/components/AgentMark"

import { leftMid, rightMid, useAnchors } from "../kit/anchors"
import { Instrument } from "../kit/Chapter"
import { useFrames } from "../kit/hooks"
import { route, type Pt, type Route } from "../kit/route"
import { Signal, SignalDefs } from "../kit/signal"

type Part = "realm" | "server" | "agents" | "keychain" | "provider" | "apps" | "feed"
type Wire = { id: string; from: Part; to: Part; row: 1 | 2 | 3; label: string; inbound?: boolean; period: number; offset: number }

/** The only lines that cross the Mac's edge, which way each runs, and how often something does. */
const WIRES: Wire[] = [
  { id: "tools", from: "server", to: "apps", row: 1, label: "only the apps you connect", period: 5.4, offset: 1.2 },
  { id: "updates", from: "feed", to: "server", row: 2, label: "signed, notarized updates", inbound: true, period: 9, offset: 3.6 },
  { id: "model", from: "agents", to: "provider", row: 3, label: "the agent's own traffic, on your own login", period: 2.8, offset: 0 },
]

/** What each part is joined to, so pointing at one lights its own lines. */
const TOUCHES: Record<Part, string[]> = {
  realm: [],
  keychain: [],
  server: ["tools", "updates"],
  agents: ["model"],
  provider: ["model"],
  apps: ["tools"],
  feed: ["updates"],
}

/**
 * Where the work lives: the Mac's edge, what stays inside it, and the only three lines that cross it,
 * each straight out along its own row. A signal runs each one now and then — the agent's own traffic
 * often, updates rarely — and none runs from ~/Realm, because nothing there leaves.
 */
export function WhereItLives() {
  const ref = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(ref)
  const [hot, setHot] = useState<Part | null>(null)
  const [t, setT] = useState(0)
  useFrames(ref, (_, dt) => setT((x) => x + dt))

  const routes: Partial<Record<string, Route>> = {}
  if (anchors.width >= 768) {
    for (const w of WIRES) {
      const inside = anchors.at[`part-${w.inbound ? w.to : w.from}`]
      const outside = anchors.at[`part-${w.inbound ? w.from : w.to}`]
      const rowBox = anchors.at[`row-${w.row}`]
      if (!inside || !outside || !rowBox) continue
      const y = rowBox.y + rowBox.h / 2
      const a: Pt = [rightMid(inside)[0], y]
      const b: Pt = [leftMid(outside)[0], y]
      routes[w.id] = w.inbound ? route([b, a]) : route([a, b])
    }
  }
  const lit = (id: string) => hot !== null && TOUCHES[hot].includes(id)
  const hover = (part: Part) => ({ onPointerEnter: () => setHot(part), onPointerLeave: () => setHot(null), onFocus: () => setHot(part), onBlur: () => setHot(null) })

  return (
    <Instrument kind="Diagram" caption="What stays on your Mac, and the only lines that leave it. Point at a part to see its lines.">
      <div ref={ref} className="relative">
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible md:block" fill="none">
          <SignalDefs id="local" />
          {WIRES.map((w) => {
            const r = routes[w.id]
            if (!r) return null
            const phase = ((t + w.offset) % w.period) / Math.min(1.7, w.period)
            return (
              <g key={w.id}>
                <path d={r.d} stroke={lit(w.id) ? "oklch(1 0 0 / 0.8)" : "oklch(1 0 0 / 0.3)"} strokeDasharray={w.inbound ? "3 4" : undefined} className="transition-[stroke] duration-200" />
                {phase < 1 ? <Signal defs="local" route={r} s={r.length * phase} alpha={Math.min(1, (1 - phase) / 0.1, phase / 0.08)} /> : null}
              </g>
            )
          })}
        </svg>

        <div className="relative grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(3.5rem,0.42fr)_minmax(0,1fr)] md:grid-rows-[auto_auto_auto_auto] md:gap-x-3 md:gap-y-3">
          {/* The Mac's edge: the one line in the drawing that matters most. */}
          <div aria-hidden className="pointer-events-none absolute hidden rounded-[22px] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.32)] md:-inset-4 md:block md:[grid-area:1/1/5/3]" />
          <p className="flex items-baseline justify-between text-[13px] text-ink md:col-span-2 md:row-start-1">
            Your Mac
            <span className="text-[12px] text-ink-3">no account, nothing uploaded</span>
          </p>
          <p className="hidden text-[13px] text-ink-2 md:col-start-4 md:row-start-1 md:block">Outside it</p>

          <Block part="realm" hot={hot} hover={hover("realm")} title="~/Realm" mono note="Files and a SQLite database on disk. Nothing here leaves." className="md:col-start-1 md:row-span-2 md:row-start-2">
            <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
              <li>Transcripts</li>
              <li>Documents</li>
              <li>Skills</li>
              <li>Checkpoints</li>
            </ul>
          </Block>
          <Block part="server" hot={hot} hover={hover("server")} title="realm-server" mono note="Keeps your sessions running, with the window open or not." className="md:col-start-2 md:row-span-2 md:row-start-2" />
          <Block part="keychain" hot={hot} hover={hover("keychain")} title="Keychain" note="Holds the key your OAuth tokens are encrypted with." className="md:col-start-1 md:row-start-4" />
          <Block part="agents" hot={hot} hover={hover("agents")} title="Your agents' CLIs" note="On the plan you already pay for." className="md:col-start-2 md:row-start-4">
            <span className="mt-2.5 flex flex-wrap gap-2 text-ink-2">
              {(["claude", "openai", "cursor", "gemini", "opencode", "githubCopilot", "goose", "qwen", "grok"] as const).map((id) => (
                <AgentMark key={id} id={id} className="size-3.5" />
              ))}
            </span>
          </Block>

          {/* Rows the lines run along, one per line, measured so each runs straight. */}
          <span aria-hidden data-anchor="row-1" className="pointer-events-none hidden md:col-start-3 md:row-start-2 md:block" />
          <span aria-hidden data-anchor="row-2" className="pointer-events-none hidden md:col-start-3 md:row-start-3 md:block" />
          <span aria-hidden data-anchor="row-3" className="pointer-events-none hidden md:col-start-3 md:row-start-4 md:block" />

          <Block part="apps" hot={hot} hover={hover("apps")} title="Apps you connect" note="Realm calls them for your agents, which never get the credential." outside className="md:col-start-4 md:row-start-2">
            <span className="mt-2.5 flex gap-2 text-ink-2">
              {(["linear", "github", "notion", "slack", "figma"] as const).map((id) => (
                <ToolMark key={id} id={id} className="size-3.5" />
              ))}
            </span>
          </Block>
          <Block part="feed" hot={hot} hover={hover("feed")} title="The public release feed" note="Signed and notarized builds. The source is on GitHub." outside className="md:col-start-4 md:row-start-3" />
          <Block part="provider" hot={hot} hover={hover("provider")} title="Your model provider" note="The agent talks to it itself. Realm never proxies it, and never asks for a key." outside className="md:col-start-4 md:row-start-4" />
        </div>

        <ul className="mt-9 hidden gap-x-6 gap-y-1 text-[12.5px] text-ink-3 md:flex md:flex-wrap">
          {WIRES.map((w) => (
            <li key={w.id} className="flex items-center gap-2">
              <svg aria-hidden width="22" height="6" viewBox="0 0 22 6" fill="none">
                <path d="M1 3h20" stroke="oklch(1 0 0 / 0.5)" strokeDasharray={w.inbound ? "3 3" : undefined} />
              </svg>
              {w.label}
            </li>
          ))}
        </ul>
      </div>
    </Instrument>
  )
}

function Block({
  part,
  title,
  note,
  children,
  hot,
  hover,
  mono = false,
  outside = false,
  className = "",
}: {
  part: Part
  title: string
  note: string
  children?: ReactNode
  hot: Part | null
  hover: Record<string, () => void>
  mono?: boolean
  outside?: boolean
  className?: string
}) {
  const lit = hot === part || (hot !== null && TOUCHES[hot].some((w) => TOUCHES[part].includes(w)))
  return (
    <div
      data-anchor={`part-${part}`}
      tabIndex={0}
      {...hover}
      className={`rounded-[14px] px-4 py-3.5 outline-offset-2 transition-[box-shadow,background-color] duration-200 ${
        lit ? "bg-raised shadow-[inset_0_0_0_1px_oklch(1_0_0/0.3)]" : outside ? "shadow-[inset_0_0_0_1px_oklch(1_0_0/0.14)]" : "bg-canvas"
      } ${className}`}
    >
      <p className={`text-ink ${mono ? "font-mono text-[12.5px]" : "text-[13.5px]"}`}>{title}</p>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-ink-2">{note}</p>
      {children}
    </div>
  )
}

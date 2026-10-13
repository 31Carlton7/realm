"use client"

import { useRef, useState, type ReactNode } from "react"

import { AgentMark, ToolMark } from "@/components/AgentMark"

import { leftMid, rightMid, useAnchors } from "../kit/anchors"
import { Instrument } from "../kit/Chapter"
import { useFrames } from "../kit/hooks"
import { route, type Pt, type Route } from "../kit/route"
import { Signal, SignalDefs } from "../kit/signal"

type Part = "realm" | "server" | "agents" | "keychain" | "provider" | "apps" | "feed"
type Wire = { id: string; from: Part; to: Part; label: string; inbound?: boolean; period: number; offset: number }

/** The only lines that cross the Mac's edge, and which way they run. Everything else stays in. */
const WIRES: Wire[] = [
  { id: "model", from: "agents", to: "provider", label: "the agent's own traffic, on your own login", period: 2.6, offset: 0 },
  { id: "tools", from: "server", to: "apps", label: "only the apps you connect", period: 5.2, offset: 1.4 },
  { id: "updates", from: "feed", to: "server", label: "signed, notarized updates", inbound: true, period: 9, offset: 4 },
]

/** What each part is joined to, so hovering one lights its own lines. */
const TOUCHES: Record<Part, string[]> = {
  realm: [],
  server: ["tools", "updates"],
  agents: ["model"],
  keychain: [],
  provider: ["model"],
  apps: ["tools"],
  feed: ["updates"],
}

export function WhereItLives() {
  const ref = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(ref)
  const [hot, setHot] = useState<Part | null>(null)
  const [t, setT] = useState(0)
  useFrames(ref, (_, dt) => setT((x) => x + dt))

  const routes: Partial<Record<string, Route>> = {}
  if (anchors.width >= 640) {
    for (const w of WIRES) {
      const a = anchors.at[`part-${w.from}`]
      const b = anchors.at[`part-${w.to}`]
      if (!a || !b) continue
      const from: Pt = w.inbound ? leftMid(a) : rightMid(a)
      const to: Pt = w.inbound ? rightMid(b) : leftMid(b)
      const turn = (from[0] + to[0]) / 2
      const pts: Pt[] = Math.abs(from[1] - to[1]) < 1 ? [from, to] : [from, [turn, from[1]], [turn, to[1]], to]
      routes[w.id] = route(pts, 12)
    }
  }
  const lit = (id: string) => hot !== null && TOUCHES[hot].includes(id)
  const hover = (part: Part) => ({ onPointerEnter: () => setHot(part), onPointerLeave: () => setHot(null), onFocus: () => setHot(part), onBlur: () => setHot(null) })

  return (
    <Instrument kind="Diagram" caption="What stays on your Mac, and the only lines that leave it.">
      <div ref={ref} className="relative">
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible md:block" fill="none">
          <SignalDefs id="local" />
          {WIRES.map((w) => {
            const r = routes[w.id]
            if (!r) return null
            const on = lit(w.id)
            // A signal runs each line now and then: the agent's own traffic often, updates rarely.
            const phase = ((t + w.offset) % w.period) / Math.min(1.6, w.period)
            return (
              <g key={w.id}>
                <path d={r.d} stroke={on ? "oklch(1 0 0 / 0.8)" : "oklch(1 0 0 / 0.3)"} strokeDasharray={w.inbound ? "3 4" : undefined} className="transition-[stroke] duration-200" />
                {phase < 1 ? <Signal defs="local" route={r} s={r.length * phase} alpha={Math.min(1, (1 - phase) / 0.1, phase / 0.08)} /> : null}
              </g>
            )
          })}
        </svg>

        <div className="relative grid gap-6 md:grid-cols-[minmax(0,1.75fr)_minmax(3rem,0.45fr)_minmax(0,1fr)] md:items-center">
          {/* The Mac: its edge is the one that matters. */}
          <div className="rounded-[22px] p-4 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.3)] sm:p-5">
            <p className="mb-4 flex items-baseline justify-between text-[13px] text-ink">
              Your Mac
              <span className="text-[12px] text-ink-3">no account, nothing uploaded</span>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Block part="realm" hot={hot} hover={hover("realm")} title="~/Realm" note="Files and a SQLite database on disk.">
                <ul className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
                  <li>Transcripts</li>
                  <li>Documents</li>
                  <li>Skills</li>
                  <li>Checkpoints</li>
                </ul>
              </Block>
              <div className="grid gap-3">
                <Block part="server" hot={hot} hover={hover("server")} title="realm-server" note="Keeps your sessions running, with the window open or not." />
                <Block part="keychain" hot={hot} hover={hover("keychain")} title="Keychain" note="Holds the key your OAuth tokens are encrypted with." />
              </div>
              <Block part="agents" hot={hot} hover={hover("agents")} title="Your agents' CLIs" note="Claude Code, Codex and the rest, on the plan you already pay for." className="sm:col-span-2">
                <span className="mt-2.5 flex gap-2 text-ink-2">
                  {(["claude", "openai", "cursor", "gemini", "opencode", "githubCopilot", "goose", "qwen", "grok"] as const).map((id) => (
                    <AgentMark key={id} id={id} className="size-3.5" />
                  ))}
                </span>
              </Block>
            </div>
          </div>

          <div aria-hidden className="hidden md:block" />

          {/* Outside: where the lines go, and what they carry. */}
          <div className="grid gap-3">
            <Block part="provider" hot={hot} hover={hover("provider")} title="Your model provider" note="The agent talks to it directly. Realm never proxies it and never asks for a key." outside />
            <Block part="apps" hot={hot} hover={hover("apps")} title="Apps you connect" note="Realm calls them for your agents. The agents never get the credential." outside>
              <span className="mt-2.5 flex gap-2 text-ink-2">
                {(["linear", "github", "notion", "slack", "figma"] as const).map((id) => (
                  <ToolMark key={id} id={id} className="size-3.5" />
                ))}
              </span>
            </Block>
            <Block part="feed" hot={hot} hover={hover("feed")} title="The public release feed" note="Where updates come from: signed and notarized builds, and the source is on GitHub." outside />
          </div>
        </div>

        <ul className="mt-5 hidden gap-x-6 gap-y-1 text-[12.5px] text-ink-3 md:flex md:flex-wrap">
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
  outside = false,
  className = "",
}: {
  part: Part
  title: string
  note: string
  children?: ReactNode
  hot: Part | null
  hover: Record<string, () => void>
  outside?: boolean
  className?: string
}) {
  const lit = hot === part || (hot !== null && TOUCHES[hot].some((w) => TOUCHES[part].includes(w)))
  return (
    <div
      data-anchor={`part-${part}`}
      tabIndex={0}
      {...hover}
      className={`rounded-[14px] px-4 py-3.5 transition-[box-shadow,background-color] duration-200 outline-offset-2 ${
        lit ? "bg-raised/70 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.35)]" : outside ? "shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "bg-canvas shadow-[inset_0_0_0_1px_var(--color-line)]"
      } ${className}`}
    >
      <p className={`text-[13.5px] text-ink ${part === "realm" || part === "server" ? "font-mono text-[12.5px]" : ""}`}>{title}</p>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-ink-2">{note}</p>
      {children}
    </div>
  )
}

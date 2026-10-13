"use client"

import { useRef, useState, type CSSProperties } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"
import { Icon } from "@/components/home/mini/icons"

import { rightMid, useAnchors, type Anchors } from "../kit/anchors"
import { Instrument } from "../kit/Chapter"
import { route, type Pt, type Route } from "../kit/route"
import { useFrames } from "../kit/hooks"
import { easeInOut } from "../kit/math"
import { Signal, SignalDefs } from "../kit/signal"

type Harness = "claude" | "codex" | "acp"

const AGENTS: { id: AgentId; name: string; harness: Harness }[] = [
  { id: "claude", name: "Claude Code", harness: "claude" },
  { id: "openai", name: "Codex", harness: "codex" },
  { id: "cursor", name: "Cursor", harness: "acp" },
  { id: "gemini", name: "Gemini", harness: "acp" },
  { id: "opencode", name: "OpenCode", harness: "acp" },
  { id: "githubCopilot", name: "GitHub Copilot", harness: "acp" },
  { id: "goose", name: "goose", harness: "acp" },
  { id: "qwen", name: "Qwen Code", harness: "acp" },
  { id: "grok", name: "Grok", harness: "acp" },
]

/** How each agent reaches Realm, from the FAQ: two have adapters of their own, the rest share one. */
const HARNESS: Record<Harness, { name: string; short: string; install: string }> = {
  claude: { name: "Claude Code's adapter", short: "Claude Code", install: "Ships with Realm, so there is nothing to install." },
  codex: { name: "Codex's adapter", short: "Codex", install: "Installs and signs in during first run." },
  acp: {
    name: "Agent Client Protocol",
    short: "Agent Client Protocol",
    install: "You install it. Realm checks what's on your Mac and gives you the exact install or login command.",
  },
}

const ROW = 40

/**
 * Bring your agent: a patch bay of the agents Realm runs, each wired through the adapter that speaks
 * to it, into one workspace. Pick an agent and the patch moves; the workspace on the right is the
 * same space whichever agent answers in it — only the agent's own login, models and permission modes
 * change with it.
 */
export function Switchboard() {
  const [picked, setPicked] = useState<AgentId>("claude")
  const boardRef = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(boardRef)
  const agent = AGENTS.find((a) => a.id === picked)!
  const harness = HARNESS[agent.harness]
  // The patched agent at work: its traffic runs through the adapter into the workspace, now and
  // then, for as long as the board is on screen. Picking an agent sends the first run at once.
  const [clock, setClock] = useState(0)
  useFrames(boardRef, (_, dt) => setClock((c) => c + dt))

  const pick = (id: AgentId) => {
    if (id === picked) return
    setPicked(id)
    setClock(0)
  }

  const wires = layoutWires(anchors)

  return (
    <Instrument kind="Sample" caption="Pick an agent. The workspace it answers in stays the same.">
      <div ref={boardRef} className="relative">
        {/* Wires under everything: each agent into its adapter, each adapter into the workspace. */}
        {wires ? (
          <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible sm:block" fill="none">
            <SignalDefs id="switch" />
            {AGENTS.map((a) => {
              const w = wires.jack[a.id]
              if (!w) return null
              const lit = a.id === picked
              return <path key={a.id} d={w.d} stroke={lit ? "oklch(1 0 0 / 0.85)" : "oklch(1 0 0 / 0.2)"} strokeWidth={lit ? 1.25 : 1} className="transition-[stroke] duration-300" />
            })}
            {(Object.keys(HARNESS) as Harness[]).map((h) => {
              const w = wires.harness[h]
              if (!w) return null
              const lit = h === agent.harness
              return <path key={h} d={w.d} stroke={lit ? "oklch(1 0 0 / 0.85)" : "oklch(1 0 0 / 0.2)"} strokeWidth={lit ? 1.25 : 1} className="transition-[stroke] duration-300" />
            })}
            {(() => {
              const run = (clock % 3.4) / 1.25
              if (run >= 1) return null
              const first = run < 0.4
              const r = first ? wires.jack[picked] : wires.harness[agent.harness]
              if (!r) return null
              const k = first ? run / 0.4 : (run - 0.4) / 0.6
              const alpha = first ? Math.min(1, k / 0.15) : Math.min(1, (1 - k) / 0.12)
              return <Signal defs="switch" route={r} s={easeInOut(k) * r.length} alpha={alpha} />
            })()}
          </svg>
        ) : null}

        <div className="relative grid gap-y-8 sm:grid-cols-[minmax(0,10rem)_minmax(2.5rem,1fr)_minmax(0,8rem)_minmax(2.5rem,1fr)_minmax(0,16rem)] sm:gap-y-0">
          {/* Column heads, as a drawing labels its columns. */}
          <p aria-hidden className="hidden pb-3 text-right font-mono text-[11.5px] text-ink-3 sm:col-start-1 sm:block">agent</p>
          <p aria-hidden className="hidden pb-3 text-center font-mono text-[11.5px] text-ink-3 sm:col-start-3 sm:block">adapter</p>
          <p aria-hidden className="hidden pb-3 font-mono text-[11.5px] text-ink-3 sm:col-start-5 sm:block">workspace</p>

          {/* The jacks: each agent's name, then its socket, so a wire leaves the socket and never crosses a word. */}
          <fieldset className="grid grid-cols-3 gap-1 sm:col-start-1 sm:row-start-2 sm:grid-cols-1 sm:gap-0 sm:[grid-auto-rows:var(--row)]" style={{ "--row": `${ROW}px` } as CSSProperties}>
            <legend className="sr-only">The agent</legend>
            {AGENTS.map((a) => {
              const on = a.id === picked
              return (
                <label
                  key={a.id}
                  className={`group flex min-w-0 cursor-pointer items-center justify-end gap-2.5 rounded-[10px] text-[13px] transition-colors duration-200 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent max-sm:flex-col-reverse max-sm:justify-center max-sm:gap-1.5 max-sm:py-2 max-sm:text-center ${on ? "text-ink" : "text-ink-2 hover:text-ink"}`}
                >
                  <input type="radio" name="switchboard-agent" value={a.id} checked={on} onChange={() => pick(a.id)} className="sr-only" />
                  <span className="truncate max-sm:text-[12px]">{a.name}</span>
                  <span
                    data-anchor={`jack-${a.id}`}
                    className={`grid size-[26px] shrink-0 place-items-center rounded-full bg-page transition-[box-shadow] duration-200 ${on ? "shadow-[inset_0_0_0_1px_var(--color-accent),0_0_0_3px_oklch(0.68_0.173_253.301/0.18)]" : "shadow-[inset_0_0_0_1px_oklch(1_0_0/0.22)] group-hover:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.4)]"}`}
                  >
                    <AgentMark id={a.id} className="size-3.5" />
                  </span>
                </label>
              )
            })}
          </fieldset>

          {/* The adapters, each beside the agents it speaks to. */}
          <div aria-hidden className="hidden sm:col-start-3 sm:row-start-2 sm:grid" style={{ gridTemplateRows: `${ROW}px ${ROW}px ${ROW * 7}px` }}>
            {(Object.keys(HARNESS) as Harness[]).map((h) => {
              const lit = h === agent.harness
              return (
                <div key={h} className={`flex items-center ${h === "acp" ? "py-1.5" : "py-[6px]"}`}>
                  <span
                    data-anchor={`adapter-${h}`}
                    className={`flex h-full w-full items-center justify-center rounded-[8px] px-2 text-center text-[12.5px] leading-[1.3] transition-[box-shadow,color,background-color] duration-300 ${lit ? "bg-raised text-ink shadow-[inset_0_0_0_1px_oklch(1_0_0/0.5)]" : "bg-canvas text-ink-2 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]"}`}
                  >
                    {h === "acp" ? (
                      <span>
                        Agent Client Protocol
                        <span className="mt-1.5 block text-[12px] text-ink-3">one adapter, seven agents</span>
                      </span>
                    ) : (
                      HARNESS[h].short
                    )}
                  </span>
                </div>
              )
            })}
          </div>

          {/* The workspace: the same space, whichever agent answers in it. */}
          <div data-anchor="workspace" aria-live="polite" className="rounded-[14px] bg-canvas p-4 sm:col-start-5 sm:row-start-2 sm:self-center">
            <div className="flex items-center gap-2.5">
              <span data-anchor="socket" className="grid size-[30px] place-items-center rounded-full bg-page text-ink shadow-[inset_0_0_0_1px_var(--color-green)]">
                <AgentMark id={agent.id} className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-[520] text-ink">{agent.name}</p>
                <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <span className="text-[oklch(0.72_0.15_250)]">
                    <Icon name="grid" className="h-3 w-3" />
                  </span>
                  Dashboard
                </p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px] leading-[1.45]">
              <dt className="text-ink-3">Through</dt>
              <dd className="text-ink-2">{harness.name}</dd>
              <dt className="text-ink-3">Signs in</dt>
              <dd className="text-ink-2">with its own login</dd>
              <dt className="text-ink-3">Models</dt>
              <dd className="text-ink-2">its own, in one picker</dd>
              <dt className="text-ink-3">Modes</dt>
              <dd className="text-ink-2">its own permission modes</dd>
              <dt className="text-ink-3">API key</dt>
              <dd className="text-ink">none, ever</dd>
            </dl>
            <p className="mt-3 text-[12.5px] leading-[1.5] text-ink-2">{harness.install}</p>
            <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-[1.5] text-ink-2">
              The same either way: the checkout, its terminals, browsers and documents, and the space&rsquo;s connections.
            </p>
          </div>
        </div>
      </div>
    </Instrument>
  )
}

type Wires = { jack: Partial<Record<AgentId, Route>>; harness: Partial<Record<Harness, Route>> }

/** Straight from each jack into its adapter at the jack's own height; then the three adapters
 *  converge, a pitch apart, on the workspace's socket. */
function layoutWires(a: Anchors): Wires | null {
  const ws = a.at.workspace
  const socket = a.at.socket
  if (!ws || !socket || a.width < 600) return null
  const jack: Wires["jack"] = {}
  for (const ag of AGENTS) {
    const j = a.at[`jack-${ag.id}`]
    const ad = a.at[`adapter-${ag.harness}`]
    if (!j || !ad) continue
    const from = rightMid(j)
    jack[ag.id] = route([[from[0], from[1]], [ad.x, from[1]]])
  }
  const harness: Wires["harness"] = {}
  const order: Harness[] = ["claude", "codex", "acp"]
  const sy = socket.y + socket.h / 2
  order.forEach((h, i) => {
    const ad = a.at[`adapter-${h}`]
    if (!ad) return
    const from = rightMid(ad)
    const y = sy + (i - 1) * 7
    const into: Pt = [ws.x, y]
    const turn = ws.x - 22 - (2 - i) * 9
    const pts: Pt[] = Math.abs(from[1] - y) < 1 ? [from, into] : [from, [turn, from[1]], [turn, y], into]
    harness[h] = route(pts, 10)
  })
  return { jack, harness }
}

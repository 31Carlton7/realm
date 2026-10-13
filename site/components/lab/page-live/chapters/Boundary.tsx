"use client"

import { useRef, useState } from "react"

import { AgentMark } from "@/components/AgentMark"

import { leftMid, rightMid, useAnchors } from "../kit/anchors"
import { Instrument } from "../kit/Chapter"
import { route, type Pt, type Route } from "../kit/route"
import { Signal, SignalDefs, useTrips } from "../kit/signal"

type Posture = "workspace" | "readonly" | "none"
type Zone = "checkout" | "later" | "credentials" | "network"
type Op = "read" | "write" | "send"

/** The three postures a space can take, in the app's own words (Settings ▸ Sandbox). */
const POSTURES: { id: Posture; name: string; note?: string }[] = [
  { id: "workspace", name: "Workspace write" },
  { id: "readonly", name: "Read only" },
  { id: "none", name: "No sandbox", note: "the default" },
]

const ZONES: { id: Exclude<Zone, "network">; name: string; paths: string }[] = [
  { id: "checkout", name: "The space's checkout", paths: "~/code/dashboard, its build caches, the agent's own state, temp" },
  { id: "later", name: "Files that run something later", paths: "~/.zshrc, ~/.gitconfig, ~/.claude/settings.json" },
  { id: "credentials", name: "Credential folders", paths: "~/.ssh, ~/.aws" },
]

const TRIES: { id: string; label: string; zone: Zone; op: Op }[] = [
  { id: "edit", label: "edit web/lib/orgs.ts", zone: "checkout", op: "write" },
  { id: "install", label: "npm install", zone: "checkout", op: "write" },
  { id: "readrc", label: "read ~/.zshrc", zone: "later", op: "read" },
  { id: "writerc", label: "write ~/.zshrc", zone: "later", op: "write" },
  { id: "ssh", label: "read ~/.ssh", zone: "credentials", op: "read" },
  { id: "curl", label: "curl api.linear.app", zone: "network", op: "send" },
]

/** What a posture lets through to a zone, as the app's posture cards describe each one. */
function verdict(posture: Posture, zone: Zone, op: Op): { ok: boolean; why: string } {
  if (zone === "network") return { ok: true, why: "The network stays open: the sandbox limits what a session can damage or read, not what it can send." }
  if (posture === "none") return { ok: true, why: "With no sandbox, the agent can do anything your account can." }
  if (zone === "credentials") return { ok: false, why: "Credential folders can't be read at all." }
  if (zone === "later") return op === "read" ? { ok: true, why: "These can be read." } : { ok: false, why: "Files that run something later can be read, but not changed." }
  if (posture === "readonly" && op === "write") return { ok: false, why: "In Read only, agents write nothing but their own temp folder, so edits, installs and builds fail." }
  return { ok: true, why: "The checkout and its caches are writable." }
}

const access = (posture: Posture, zone: Exclude<Zone, "network">) => {
  const r = verdict(posture, zone, "read").ok
  const w = verdict(posture, zone, "write").ok
  return r && w ? "read and write" : r ? "read only" : "no access"
}

export function Boundary() {
  const [posture, setPosture] = useState<Posture>("workspace")
  const [log, setLog] = useState<{ id: number; label: string; ok: boolean; why: string }[]>([])
  const [hit, setHit] = useState<{ zone: Zone; ok: boolean; at: number } | null>(null)
  const plan = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(plan, [posture])
  const trips = useTrips<Zone>()
  const nextId = useRef(1)

  const wires: Partial<Record<Zone, Route>> = {}
  const agent = anchors.at.agent
  if (agent && anchors.width >= 600) {
    const from = rightMid(agent)
    for (const z of ZONES) {
      const box = anchors.at[`zone-${z.id}`]
      if (!box) continue
      const to = leftMid(box)
      const turn = from[0] + (to[0] - from[0]) * 0.5
      const pts: Pt[] = Math.abs(to[1] - from[1]) < 1 ? [from, to] : [from, [turn, from[1]], [turn, to[1]], to]
      wires[z.id] = route(pts, 12)
    }
    const net = anchors.at.network
    if (net) {
      const top = anchors.at["zone-checkout"]
      const y = (top?.y ?? from[1]) - 26
      wires.network = route([[from[0] - (agent.w / 2), agent.y], [from[0] - agent.w / 2, y], [net.x, y]], 12)
    }
  }

  const tryIt = (t: (typeof TRIES)[number]) => {
    const v = verdict(posture, t.zone, t.op)
    const duration = 700
    trips.fire(t.zone, duration)
    const land = () => {
      setHit({ zone: t.zone, ok: v.ok, at: performance.now() })
      setLog((l) => [{ id: nextId.current++, label: t.label, ...v }, ...l].slice(0, 3))
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) land()
    else window.setTimeout(land, duration)
  }

  return (
    <Instrument kind="Sample" caption="Pick a posture, then try something. The drawing shows where the policy stops it.">
      <div role="radiogroup" aria-label="The space's sandbox" className="mb-6 inline-flex flex-wrap gap-1 rounded-[12px] bg-canvas p-1">
        {POSTURES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={posture === p.id}
            onClick={() => {
              setPosture(p.id)
              setHit(null)
            }}
            className="app-corner flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[13px] text-ink-2 transition-colors duration-150 hover:text-ink aria-checked:bg-raised aria-checked:text-ink"
          >
            {p.name}
            {p.note ? <span className="text-[12px] text-ink-3">· {p.note}</span> : null}
          </button>
        ))}
      </div>

      <div ref={plan} className="relative">
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible sm:block" fill="none">
          <SignalDefs id="sandbox" />
          {(Object.keys(wires) as Zone[]).map((z) => {
            const r = wires[z]!
            const blocked = z !== "network" && access(posture, z) === "no access"
            return <path key={z} d={r.d} stroke={blocked ? "oklch(1 0 0 / 0.12)" : "oklch(1 0 0 / 0.3)"} strokeDasharray={z === "network" ? "3 4" : undefined} />
          })}
          {trips.trips.map((trip) => {
            const r = wires[trip.key]
            if (!r || !trips.started(trip)) return null
            const k = trips.progress(trip)
            return <Signal key={trip.id} defs="sandbox" route={r} s={r.length * k} alpha={Math.min(1, k / 0.08)} />
          })}
        </svg>

        <div className="relative grid gap-y-5 sm:grid-cols-[minmax(0,10.5rem)_minmax(3rem,1fr)_minmax(0,21rem)] sm:items-center">
          {/* The process the policy wraps: the agent, and everything it starts. */}
          <div
            data-anchor="agent"
            className={`rounded-[14px] bg-canvas p-4 transition-[box-shadow] duration-300 ${posture === "none" ? "shadow-[inset_0_0_0_1px_var(--color-line)]" : "shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.55),0_0_0_4px_oklch(0.68_0.173_253.301/0.08)]"}`}
          >
            <span className="grid size-8 place-items-center rounded-full bg-page text-ink shadow-[inset_0_0_0_1px_oklch(1_0_0/0.25)]">
              <AgentMark id="claude" className="size-4" />
            </span>
            <p className="mt-3 text-[13px] leading-[1.4] text-ink">The agent, and every process it starts</p>
            <p className="mt-1 text-[12px] leading-[1.45] text-ink-3">{posture === "none" ? "Runs with your full account." : "Inside a macOS Seatbelt policy."}</p>
          </div>

          <div className="sm:col-start-3 sm:space-y-3">
            <p data-anchor="network" className="mb-3 flex items-center justify-between text-[12.5px] text-ink-2 sm:mb-1">
              <span>The network</span>
              <span className="text-ink-3">open in every posture</span>
            </p>
            {ZONES.map((z) => {
              const a = access(posture, z.id)
              const lit = hit?.zone === z.id
              return (
                <div
                  key={z.id}
                  data-anchor={`zone-${z.id}`}
                  className={`relative mb-3 rounded-[12px] px-4 py-3 transition-[box-shadow,background-color] duration-300 sm:mb-0 ${
                    lit && !hit!.ok
                      ? "bg-[oklch(0.666_0.18_21.433/0.07)] shadow-[inset_0_0_0_1px_oklch(0.666_0.18_21.433/0.7)]"
                      : lit
                        ? "bg-raised/60 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.4)]"
                        : a === "no access"
                          ? "shadow-[inset_0_0_0_1px_oklch(1_0_0/0.22)] [background:repeating-linear-gradient(135deg,oklch(1_0_0/0.025)_0_1px,transparent_1px_7px)]"
                          : "bg-canvas shadow-[inset_0_0_0_1px_var(--color-line)]"
                  }`}
                >
                  <p className="flex items-baseline justify-between gap-3 text-[13px] text-ink">
                    {z.name}
                    <span className={`shrink-0 text-[12px] ${a === "no access" ? "text-red" : a === "read only" ? "text-orange" : "text-green"}`}>{a}</span>
                  </p>
                  <p className="mt-1 font-mono text-[11.5px] leading-[1.5] text-ink-3">{z.paths}</p>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-7">
        <p className="mb-2.5 text-[12.5px] text-ink-3">Try</p>
        <div className="flex flex-wrap gap-1.5">
          {TRIES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => tryIt(t)}
              className="app-corner rounded-[8px] bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors duration-150 hover:bg-raised hover:text-ink"
            >
              {t.label}
            </button>
          ))}
        </div>
        <ul aria-live="polite" className="mt-4 min-h-[4.5rem] space-y-1.5">
          {log.map((entry, i) => (
            <li key={entry.id} className={`flex gap-2.5 text-[13px] leading-[1.5] transition-opacity duration-300 ${i ? "opacity-55" : ""}`}>
              <span className={`shrink-0 font-[520] ${entry.ok ? "text-green" : "text-red"}`}>{entry.ok ? "Allowed" : "Refused"}</span>
              <span className="shrink-0 font-mono text-[12px] leading-[1.65] text-ink">{entry.label}</span>
              <span className="text-ink-2">{entry.why}</span>
            </li>
          ))}
        </ul>
      </div>
    </Instrument>
  )
}

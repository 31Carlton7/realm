"use client"

import { useMemo, useRef, useState } from "react"

import { Icon } from "@/components/home/mini/icons"
import { Realmite, realmiteFromSeed, type RealmiteState } from "@/lib/realmite"

import { useAnchors } from "../kit/anchors"
import { Instrument } from "../kit/Chapter"
import { useFrames } from "../kit/hooks"
import { easeInOut } from "../kit/math"
import { pointAt, route, sAtX, slice, type Pt } from "../kit/route"
import { SignalDefs } from "../kit/signal"

type RoleId = "researcher" | "producer" | "editor" | "ops"
type Role = { id: RoleId; name: string; goal: string; handsTo: string; seed: string }

/** The landing page's sample team (components/home/Teams.tsx): the same roles, goals and creatures. */
const ROLES: Role[] = [
  { id: "researcher", name: "Researcher", goal: "Find three stories a week the audience hasn't seen yet.", handsTo: "Content Producer", seed: "realm-researcher-7" },
  { id: "producer", name: "Content Producer", goal: "Turn each story into a newsletter and a set of posts.", handsTo: "Editor", seed: "realm-producer-2" },
  { id: "editor", name: "Editor", goal: "Hold every draft to the style guide before it reaches you.", handsTo: "You, in Review", seed: "realm-editor-11" },
  { id: "ops", name: "Ops", goal: "Keep the calendar, the accounts and the week's budget straight.", handsTo: "Researcher", seed: "realm-ops-4" },
]

type Item = { id: string; title: string; from: RoleId; detail: string }
const WAITING: Item[] = [
  { id: "newsletter", title: "Thursday's newsletter", from: "editor", detail: "1,240 words · 3 stories · links checked" },
  { id: "posts", title: "Three posts for the launch", from: "producer", detail: "Scheduled for 4:10 PM, after you approve" },
]

/** The relay a story takes, and how long each hand-off travels. */
const LEGS: [RoleId | "review", RoleId | "review"][] = [
  ["researcher", "producer"],
  ["producer", "editor"],
  ["editor", "review"],
]
const LEG = 1.6
const REST = 2.4

export function TeamRelay() {
  const specs = useMemo(() => Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(r.seed)])), [])
  const [picked, setPicked] = useState<RoleId>("editor")
  const [decided, setDecided] = useState<Record<string, "approved" | "returned">>({})
  const [clock, setClock] = useState(0)
  const boardRef = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(boardRef)

  // The relay runs while the team is on screen: a story handed along, one leg at a time.
  useFrames(boardRef, (_, dt) => setClock((c) => c + dt))
  const cycle = LEGS.length * (LEG + REST)
  const t = clock % cycle
  const legIndex = Math.floor(t / (LEG + REST))
  const inLeg = t - legIndex * (LEG + REST)
  const leg = LEGS[legIndex]!
  const k = inLeg < LEG ? easeInOut(inLeg / LEG) : null

  const waiting = WAITING.filter((item) => !decided[item.id])
  const states: Record<RoleId, RealmiteState> = useMemo(() => {
    const out = { researcher: "working", producer: "idle", editor: "idle", ops: "sleeping" } as Record<RoleId, RealmiteState>
    for (const item of WAITING) {
      if (!decided[item.id]) out[item.from] = "needs-you"
      else if (decided[item.id] === "returned") out[item.from] = "working"
    }
    return out
  }, [decided])

  const role = ROLES.find((r) => r.id === picked)!
  const station = (id: RoleId | "review"): Pt | null => {
    const a = anchors.at[`role-${id}`]
    return a ? [a.x + a.w / 2, a.y + a.h / 2] : null
  }
  const line = (() => {
    const pts = (["researcher", "producer", "editor", "review"] as const).map(station)
    if (pts.some((p) => !p) || anchors.width < 600) return null
    return route(pts as Pt[], 12)
  })()
  const opsLine = (() => {
    const a = station("ops")
    const b = station("researcher")
    if (!a || !b || anchors.width < 600) return null
    return route([a, [a[0], b[1] + 40], [b[0], b[1] + 40], b], 12)
  })()

  const legPath = (() => {
    if (!line || k === null) return null
    const a = station(leg[0])
    const b = station(leg[1])
    if (!a || !b) return null
    return { from: a[0], to: b[0] }
  })()

  return (
    <Instrument kind="Sample" caption="A team of four. Click a role; approve or send back what waits in Review.">
      <div ref={boardRef} className="relative">
        {line ? (
          <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible sm:block" fill="none">
            <SignalDefs id="team" />
            <path d={line.d} stroke="oklch(1 0 0 / 0.26)" />
            {opsLine ? <path d={opsLine.d} stroke="oklch(1 0 0 / 0.18)" strokeDasharray="2 4" /> : null}
            {legPath ? (
              (() => {
                const s0 = sAtX(line, legPath.from)
                const s1 = leg[1] === "review" ? line.length : sAtX(line, legPath.to)
                const s = s0 + (s1 - s0) * k!
                const head = pointAt(line, s).p
                return (
                  <g>
                    <path d={slice(line, s - 60, s)} stroke="var(--color-accent-ink)" strokeWidth={1.5} strokeLinecap="round" opacity={0.85} />
                    <circle cx={head[0]} cy={head[1]} r={11} fill="url(#team-accent)" />
                    <rect x={head[0] - 5} y={head[1] - 6.5} width={10} height={13} rx={2} fill="var(--color-page)" stroke="oklch(0.93 0.04 250)" />
                    <path d={`M${head[0] - 2.5} ${head[1] - 2}H${head[0] + 2.5}M${head[0] - 2.5} ${head[1] + 1}H${head[0] + 2.5}`} stroke="oklch(0.93 0.04 250)" strokeWidth={0.75} />
                  </g>
                )
              })()
            ) : null}
          </svg>
        ) : null}

        <div className="relative grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,17.5rem)] sm:items-start">
          <div>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {ROLES.filter((r) => r.id !== "ops").map((r) => (
                <RoleStation key={r.id} role={r} spec={specs[r.id]!} state={states[r.id]} picked={picked === r.id} onPick={() => setPicked(r.id)} />
              ))}
            </ul>
            <ul className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {ROLES.filter((r) => r.id === "ops").map((r) => (
                <RoleStation key={r.id} role={r} spec={specs[r.id]!} state={states[r.id]} picked={picked === r.id} onPick={() => setPicked(r.id)} />
              ))}
            </ul>
            <div aria-live="polite" className="mt-6 max-w-[30rem] rounded-[12px] bg-canvas px-4 py-3 text-[13.5px]">
              <p className="text-ink">{role.goal}</p>
              <p className="mt-1 flex items-center gap-1.5 text-ink-3">
                Hands work to <Icon name="chevronRight" className="h-3 w-3" /> <span className="text-ink-2">{role.handsTo}</span>
              </p>
            </div>
          </div>

          {/* Review: where everything the team makes waits for you. */}
          <div className="rounded-[16px] bg-canvas p-4">
            <p data-anchor="role-review" className="flex items-center gap-2 text-[13px] text-ink">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${waiting.length ? "bg-orange" : "bg-ink-3/60"}`} />
              Review
              <span className="ml-auto text-[12px] text-ink-3">{waiting.length ? `${waiting.length} waiting` : "Nothing waiting"}</span>
            </p>
            <ul className="mt-3 space-y-2">
              {WAITING.map((item) => {
                const from = ROLES.find((r) => r.id === item.from)!
                const outcome = decided[item.id]
                return (
                  <li key={item.id} className="rounded-[12px] bg-page px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Realmite spec={specs[from.id]!} size={24} state={outcome ? "idle" : "needs-you"} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-ink">{item.title}</p>
                        <p className="truncate text-[12px] text-ink-3">{from.name}</p>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center gap-1.5 pl-[34px]">
                      {outcome ? (
                        <span className={`flex items-center gap-1 text-[12.5px] ${outcome === "approved" ? "text-green" : "text-ink-2"}`}>
                          {outcome === "approved" ? <Icon name="check" className="h-3.5 w-3.5" /> : null}
                          {outcome === "approved" ? "Approved, so it can go out" : `Back with the ${from.name}`}
                          <button
                            type="button"
                            onClick={() => setDecided(({ [item.id]: _, ...rest }) => rest)}
                            className="ml-2 text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink"
                          >
                            Undo
                          </button>
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setDecided((d) => ({ ...d, [item.id]: "approved" }))}
                            className="app-corner rounded-[8px] bg-accent-fill px-2.5 py-1 text-[12.5px] text-white transition-[background-color,scale] hover:bg-accent-fill-hover active:scale-[0.97]"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => setDecided((d) => ({ ...d, [item.id]: "returned" }))}
                            className="app-corner rounded-[8px] px-2.5 py-1 text-[12.5px] text-ink-2 transition-colors hover:bg-raised hover:text-ink"
                          >
                            Send back
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 text-[12px] leading-[1.5] text-ink-3">Nothing is posted, sent or published until you approve it.</p>
          </div>
        </div>
      </div>
    </Instrument>
  )
}

function RoleStation({
  role,
  spec,
  state,
  picked,
  onPick,
}: {
  role: Role
  spec: ReturnType<typeof realmiteFromSeed>
  state: RealmiteState
  picked: boolean
  onPick: () => void
}) {
  const word = state === "needs-you" ? "Needs you" : state === "working" ? "Working" : state === "sleeping" ? "Done for today" : "Idle"
  return (
    <li>
      <button
        type="button"
        aria-pressed={picked}
        onClick={onPick}
        className="flex w-full flex-col items-center gap-2 rounded-[14px] py-1 text-center"
      >
        <span
          data-anchor={`role-${role.id}`}
          className={`grid size-[60px] place-items-center rounded-full bg-page transition-[box-shadow] duration-200 ${picked ? "shadow-[inset_0_0_0_1px_var(--color-accent)]" : "shadow-[inset_0_0_0_1px_oklch(1_0_0/0.22)]"}`}
        >
          <Realmite spec={spec} size={44} state={state} />
        </span>
        <span className="text-[13px] font-[520] text-ink">{role.name}</span>
        <span className={`flex items-center gap-1.5 text-[12px] ${state === "needs-you" ? "text-orange" : state === "working" ? "text-green" : "text-ink-3"}`}>
          {state === "needs-you" || state === "working" ? <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state === "needs-you" ? "bg-orange" : "bg-green"}`} /> : null}
          {word}
        </span>
      </button>
    </li>
  )
}

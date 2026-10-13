"use client"

import { useMemo, useState } from "react"

import { Realmite, realmiteFromSeed, type RealmiteSpec, type RealmiteState } from "@/lib/realmite"

import { Register, Seam } from "./kinetic"
import s from "./paper.module.css"

type Role = { id: string; name: string; goal: string; handsTo: string; seed: string }
type Item = { id: string; title: string; from: string; detail: string }

/* The newsletter team from the landing page's Teams board (components/home/Teams.tsx). */
const ROLES: Role[] = [
  { id: "researcher", name: "Researcher", goal: "Find three stories a week the audience hasn't seen yet.", handsTo: "Content Producer", seed: "realm-researcher-7" },
  { id: "producer", name: "Content Producer", goal: "Turn each story into a newsletter and a set of posts.", handsTo: "Editor", seed: "realm-producer-2" },
  { id: "editor", name: "Editor", goal: "Hold every draft to the style guide before it reaches you.", handsTo: "You, in Review", seed: "realm-editor-11" },
  { id: "ops", name: "Ops", goal: "Keep the calendar, the accounts and the week's budget straight.", handsTo: "Researcher", seed: "realm-ops-4" },
]

const ITEMS: Item[] = [
  { id: "newsletter", title: "Thursday's newsletter", from: "editor", detail: "1,240 words · 3 stories · links checked" },
  { id: "posts", title: "Three posts for the launch", from: "producer", detail: "Scheduled for 4:10 PM, after you approve" },
]

const stateLabel = (state: RealmiteState) =>
  state === "needs-you" ? "Needs you" : state === "working" ? "Working" : state === "sleeping" ? "Done for today" : "Idle"
const stateTone = (state: RealmiteState) =>
  state === "needs-you" ? "text-orange" : state === "working" ? "text-green" : "text-ink-2"

/**
 * Teams, set as a magazine's masthead: a space's roles, each with its goal and who it hands work to,
 * each wearing a Realmite whose face is its run's state (the app's own generator, so a seed draws the
 * creature the app would). Under it, Review, where what the team made waits: approve it or send it
 * back, and the masthead answers. It is a sample of the team pages, and says so.
 */
export function Masthead() {
  const [specs, setSpecs] = useState<Record<string, RealmiteSpec>>(() =>
    Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(r.seed)])),
  )
  const [decided, setDecided] = useState<Record<string, "approved" | "returned">>({})
  const [shuffles, setShuffles] = useState(0)

  const waiting = ITEMS.filter((item) => !decided[item.id])
  const states: Record<string, RealmiteState> = useMemo(() => {
    const resting: Record<string, RealmiteState> = { researcher: "working", producer: "idle", editor: "idle", ops: "sleeping" }
    return Object.fromEntries(
      ROLES.map((r) => {
        const made = ITEMS.filter((i) => i.from === r.id)
        if (made.some((i) => !decided[i.id])) return [r.id, "needs-you"]
        if (made.some((i) => decided[i.id] === "returned")) return [r.id, "working"]
        return [r.id, resting[r.id]!]
      }),
    )
  }, [decided])

  const shuffle = () => {
    const n = shuffles + 1
    setShuffles(n)
    setSpecs(Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(`${r.seed}-shuffle-${n}`)])))
  }

  return (
    <section data-running-head="Teams" aria-labelledby="teams-title" className={s.section}>
      <Seam />
      <div className={`${s.measure} ${s.grid} gap-y-12`}>
        <div className="col-span-12 lg:col-span-5">
          <p className={`${s.note} text-accent-ink`}>New in 2.1</p>
          <Register id="teams-title" text="A team in every space." className={`${s.statement} mt-4 text-ink`} />
          <p className={`${s.body} mt-7 max-w-[46ch]`}>
            Give a space roles that each work toward a goal, on their own schedule, and hand work along to one another.
            Every role wears a Realmite whose face is its run&rsquo;s state, never a mood.
          </p>
          <p className={`${s.body} mt-4 max-w-[46ch]`}>
            What the team makes waits in Review. Nothing is posted, sent or published until you approve it, and a
            team&rsquo;s keys are used under grants only you can set.
          </p>
        </div>

        <div className="col-span-12 lg:col-span-7">
          <div className="flex items-end justify-between gap-6 border-b-2 border-ink pb-3">
            <p className="text-[clamp(1.5rem,2.4vw,2rem)] leading-none font-[620] tracking-[-0.035em] text-ink">Newsletter</p>
            <div className="flex items-center gap-4">
              <span className={`${s.note} hidden sm:inline`}>Sample · {ROLES.length} roles</span>
              <button
                type="button"
                onClick={shuffle}
                className="min-h-9 rounded-[8px] px-3 text-[14px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-colors duration-150 hover:bg-raised hover:text-ink"
              >
                Shuffle faces
              </button>
            </div>
          </div>

          <ul aria-label="Roles">
            {ROLES.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-x-4 border-b border-line py-4 xl:grid-cols-[56px_minmax(0,10rem)_minmax(0,1fr)_7.5rem] xl:items-center xl:gap-x-6"
              >
                <span className="row-span-2 xl:row-span-1">
                  <Realmite spec={specs[r.id]!} size={48} state={states[r.id]} />
                </span>
                <span className="flex items-baseline justify-between gap-4 xl:contents">
                  <span className="text-[17px] leading-[1.3] font-[580] tracking-[-0.014em] text-ink">{r.name}</span>
                  <span className={`${s.note} xl:order-last xl:text-right ${stateTone(states[r.id]!)}`}>{stateLabel(states[r.id]!)}</span>
                </span>
                <span className="mt-1 text-[15px] leading-[1.45] text-ink-2 xl:mt-0">
                  {r.goal} <span className="text-ink-3">Hands work to {r.handsTo}.</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-10 flex items-baseline justify-between border-b border-ink/70 pb-2">
            <p className="text-[17px] font-[580] tracking-[-0.014em] text-ink">Review</p>
            <p aria-live="polite" className={`${s.note} ${waiting.length ? "text-orange" : ""}`}>
              {waiting.length ? `${waiting.length} waiting` : "Nothing waiting"}
            </p>
          </div>
          <ul>
            {ITEMS.map((item) => {
              const from = ROLES.find((r) => r.id === item.from)!
              const outcome = decided[item.id]
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line py-4 sm:flex-nowrap">
                  <Realmite spec={specs[from.id]!} size={28} state={outcome ? "idle" : "needs-you"} />
                  <div className="min-w-0 flex-1 basis-[14rem]">
                    <p className="text-[16px] text-ink">{item.title}</p>
                    <p className="text-[14px] text-ink-2">
                      {from.name} · {item.detail}
                    </p>
                  </div>
                  {outcome ? (
                    <span className={`flex items-center gap-2 text-[14px] ${outcome === "approved" ? "text-green" : "text-ink-2"}`}>
                      {outcome === "approved" ? "Approved" : `Back with ${from.name}`}
                      <button
                        type="button"
                        onClick={() => setDecided(({ [item.id]: _, ...rest }) => rest)}
                        className="ml-1 min-h-9 px-1 text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
                      >
                        Undo
                      </button>
                    </span>
                  ) : (
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDecided((d) => ({ ...d, [item.id]: "returned" }))}
                        className="min-h-9 rounded-[8px] px-3 text-[14px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-colors hover:bg-raised hover:text-ink"
                      >
                        Send back
                      </button>
                      <button
                        type="button"
                        onClick={() => setDecided((d) => ({ ...d, [item.id]: "approved" }))}
                        className="min-h-9 rounded-[8px] bg-ink px-3 text-[14px] text-page transition-[background-color,scale] hover:bg-ink/85 active:scale-[0.97]"
                      >
                        Approve
                      </button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </section>
  )
}

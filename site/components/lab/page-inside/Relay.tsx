"use client"

import { useMemo, useState } from "react"

import { Icon } from "@/components/home/mini/icons"
import { Realmite, realmiteFromSeed, type RealmiteSpec, type RealmiteState } from "@/lib/realmite"

import css from "./inside.module.css"

type Role = { id: string; name: string; goal: string; handsTo: string; seed: string }
type Item = { id: string; title: string; from: string; detail: string }

/* The team the landing page shows (components/home/Teams.tsx), in the order work moves through it. */
const ROLES: Role[] = [
  { id: "ops", name: "Ops", goal: "Keep the calendar, the accounts and the week's budget straight.", handsTo: "Researcher", seed: "realm-ops-4" },
  { id: "researcher", name: "Researcher", goal: "Find three stories a week the audience hasn't seen yet.", handsTo: "Content Producer", seed: "realm-researcher-7" },
  { id: "producer", name: "Content Producer", goal: "Turn each story into a newsletter and a set of posts.", handsTo: "Editor", seed: "realm-producer-2" },
  { id: "editor", name: "Editor", goal: "Hold every draft to the style guide before it reaches you.", handsTo: "You, in Review", seed: "realm-editor-11" },
]

const ITEMS: Item[] = [
  { id: "newsletter", title: "Thursday's newsletter", from: "editor", detail: "1,240 words · 3 stories · links checked" },
  { id: "posts", title: "Three posts for the launch", from: "producer", detail: "Scheduled for 4:10 PM, after you approve" },
]

const RESTING: Record<string, RealmiteState> = { researcher: "working", producer: "idle", editor: "idle", ops: "sleeping" }

/**
 * Teams, from 2.1: a space's roles in the order work passes through them, each wearing a Realmite
 * whose face is its run's state, ending in Review, where nothing goes out until you approve it.
 *
 * The line between two roles carries a pulse while the role before it is at work: work being handed
 * along, the one thing here that moves on its own, and only while it is true. Pick a role to read
 * its goal; approve or send back what waits in Review and the roles answer; Shuffle draws new faces
 * with the app's own generator.
 */
export function Relay() {
  const [specs, setSpecs] = useState<Record<string, RealmiteSpec>>(() => Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(r.seed)])))
  const [picked, setPicked] = useState("editor")
  const [decided, setDecided] = useState<Record<string, "approved" | "returned">>({})
  const [shuffles, setShuffles] = useState(0)

  const waiting = ITEMS.filter((item) => !decided[item.id])
  const states: Record<string, RealmiteState> = useMemo(
    () =>
      Object.fromEntries(
        ROLES.map((r) => {
          const made = ITEMS.filter((i) => i.from === r.id)
          if (made.some((i) => !decided[i.id])) return [r.id, "needs-you"]
          if (made.some((i) => decided[i.id] === "returned")) return [r.id, "working"]
          return [r.id, RESTING[r.id]!]
        }),
      ),
    [decided],
  )

  const shuffle = () => {
    const n = shuffles + 1
    setShuffles(n)
    setSpecs(Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(`${r.seed}-shuffle-${n}`)])))
  }

  const role = ROLES.find((r) => r.id === picked)!

  return (
    <section aria-labelledby="team-title" className="mx-auto w-full max-w-[1680px] px-6 pt-28 pb-24 sm:px-10 sm:pt-36 lg:px-14">
      <div className="grid gap-12 lg:grid-cols-[clamp(360px,30vw,452px)_minmax(0,1fr)] lg:gap-[132px]">
        <div>
          <p className="flex items-center gap-2.5 text-[13.5px] text-ink-2">
            <span className="font-mono text-[12px] text-accent-ink">2.1</span>
            <span className="h-3.5 w-px bg-line-strong" aria-hidden />
            New in this release
          </p>
          <h2 id="team-title" className="mt-5 text-[clamp(1.9rem,3.2vw,2.75rem)] leading-[1.04] font-[580] tracking-[-0.04em] text-balance text-ink">
            A team in every space.
          </h2>
          <p className="mt-5 text-[17px] leading-[1.55] text-ink-2">
            Give a space roles that each work toward a goal, on their own schedule, and hand work along to one another.
            Every role wears a Realmite whose face is its run&rsquo;s state, never a mood.
          </p>
          <p className="mt-4 text-[17px] leading-[1.55] text-ink-2">
            What the team makes waits in Review. Nothing is posted, sent or published until you approve it, and the
            space&rsquo;s policies bind every session in it, yours included. No agent can change a policy.
          </p>
        </div>

        <div className="min-w-0">
          <div className="flex items-center justify-between">
            <p className="text-[13.5px] text-ink-2">
              <span className="text-ink">Newsletter</span> · a sample team, 4 roles
            </p>
            <button
              type="button"
              onClick={shuffle}
              className="app-corner flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-[13px] text-ink-2 transition-colors duration-150 hover:bg-raised hover:text-ink"
            >
              <Icon name="reload" className="h-3.5 w-3.5" /> Shuffle faces
            </button>
          </div>

          <ol className="relative mt-8 grid grid-cols-2 gap-y-8 sm:grid-cols-4">
            {ROLES.map((r, i) => {
              const state = states[r.id]!
              const next = ROLES[i + 1]
              return (
                <li key={r.id} className="relative flex justify-center">
                  {/* The handoff to the next role along: a hairline, and a pulse on it while this role works. */}
                  {next ? (
                    <span aria-hidden className="absolute top-[40px] left-[calc(50%+52px)] hidden h-px w-[calc(100%-104px)] bg-line-strong sm:block">
                      {state === "working" ? <span className={`${css.pulse} absolute inset-0`}>
                          <span className="absolute top-1/2 right-0 h-[5px] w-[5px] translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
                        </span> : null}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-pressed={picked === r.id}
                    onClick={() => setPicked(r.id)}
                    className="group flex w-full max-w-[150px] flex-col items-center gap-3 rounded-[16px] px-2 pt-1 pb-3 transition-colors duration-200 hover:bg-surface/60 aria-pressed:bg-surface"
                  >
                    <span className="grid h-20 w-20 place-items-center rounded-full shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow duration-200 group-aria-pressed:shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.6)]">
                      <Realmite spec={specs[r.id]!} size={60} state={state} />
                    </span>
                    <span className="text-center text-[14px] leading-[1.3] font-[520] text-ink">{r.name}</span>
                    <span className={`flex items-center gap-1.5 text-[12.5px] ${tone(state)}`}>
                      {state === "needs-you" || state === "working" ? (
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state === "needs-you" ? "bg-orange" : "bg-green"}`} />
                      ) : null}
                      {label(state)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>

          <div aria-live="polite" className="mt-6 border-l border-accent/70 pl-4">
            <p className="text-[15.5px] leading-[1.5] text-ink">{role.goal}</p>
            <p className="mt-1.5 flex items-center gap-1.5 text-[14px] text-ink-2">
              {role.name} hands work to <Icon name="chevronRight" className="h-3 w-3 text-ink-3" />
              <span className="text-ink">{role.handsTo}</span>
            </p>
          </div>

          <div className="mt-10">
            <h3 className="flex items-center gap-2.5 text-[14px] text-ink">
              Review{" "}
              {waiting.length ? (
                <span className="flex items-center gap-1.5 text-[13px] text-orange">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-orange" />
                  {waiting.length} waiting on you
                </span>
              ) : (
                <span className="text-[13px] text-ink-3">Nothing waiting</span>
              )}
            </h3>
            <ul className="mt-3 divide-y divide-line">
              {ITEMS.map((item) => {
                const from = ROLES.find((r) => r.id === item.from)!
                const outcome = decided[item.id]
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4">
                    <Realmite spec={specs[from.id]!} size={28} state={outcome ? "idle" : "needs-you"} />
                    <div className="min-w-0 flex-1 basis-[14rem]">
                      <p className="truncate text-[15px] text-ink">{item.title}</p>
                      <p className="truncate text-[13px] text-ink-3">
                        {from.name} · {item.detail}
                      </p>
                    </div>
                    {outcome ? (
                      <span className={`flex items-center gap-1 text-[13px] ${outcome === "approved" ? "text-green" : "text-ink-2"}`}>
                        {outcome === "approved" ? <Icon name="check" className="h-3.5 w-3.5" /> : null}
                        {outcome === "approved" ? "Approved" : `Back with ${from.name}`}
                        <button
                          type="button"
                          onClick={() => setDecided(({ [item.id]: _, ...rest }) => rest)}
                          className="ml-2 text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink"
                        >
                          Undo
                        </button>
                      </span>
                    ) : (
                      <span className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDecided((d) => ({ ...d, [item.id]: "returned" }))}
                          className="app-corner min-h-9 rounded-[10px] px-3 text-[13px] text-ink-2 transition-colors hover:bg-raised hover:text-ink"
                        >
                          Send back
                        </button>
                        <button
                          type="button"
                          onClick={() => setDecided((d) => ({ ...d, [item.id]: "approved" }))}
                          className="app-corner min-h-9 rounded-[10px] bg-accent-fill px-3 text-[13px] text-white transition-[background-color,scale] hover:bg-accent-fill-hover active:scale-[0.97] active:bg-accent-fill-press"
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
      </div>
    </section>
  )
}

const label = (s: RealmiteState) => (s === "needs-you" ? "Needs you" : s === "working" ? "Working" : s === "sleeping" ? "Done for today" : "Idle")
const tone = (s: RealmiteState) => (s === "needs-you" ? "text-orange" : s === "working" ? "text-green" : "text-ink-3")

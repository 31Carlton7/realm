"use client"

import { useMemo, useState } from "react"

import { Icon } from "@/components/home/mini/icons"
import { Realmite, realmiteFromSeed, type RealmiteSpec, type RealmiteState } from "@/lib/realmite"

type Role = { id: string; name: string; goal: string; handsTo: string; seed: string }
type Item = { id: string; title: string; from: string; detail: string }

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

/**
 * Teams, which arrive in 2.1: a space's roles, each wearing a Realmite whose face is its run's state
 * and never a mood, handing work along to Review, where nothing goes out until you approve it.
 *
 * The creatures are the app's own generator, ported whole (lib/realmite), so a seed here draws the
 * creature the app would. The board answers clicks the way the team pages do: pick a role to read its
 * goal and who it hands to, approve or send back what's waiting, and Shuffle for new faces.
 */
export function Teams() {
  const [specs, setSpecs] = useState<Record<string, RealmiteSpec>>(() =>
    Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(r.seed)])),
  )
  const [picked, setPicked] = useState("editor")
  const [decided, setDecided] = useState<Record<string, "approved" | "returned">>({})
  const [shuffles, setShuffles] = useState(0)

  const waiting = ITEMS.filter((item) => !decided[item.id])
  // A role needs you while something it made waits in Review, and goes back to work on what you
  // sent back; the others keep a state of their own so the board is never uniform.
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

  const role = ROLES.find((r) => r.id === picked)!

  return (
    <section aria-labelledby="teams-title" className="mx-auto w-full max-w-[92rem] px-6 pt-12 pb-24 sm:px-10 sm:pt-16 sm:pb-32">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-center lg:gap-16">
        <div>
          <p className="flex items-center gap-2 text-[13px] text-accent-ink">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            Arriving in Realm 2.1
          </p>
          <h2 id="teams-title" className="mt-4 text-[clamp(2rem,4vw,3.25rem)] leading-[1.02] font-[580] tracking-[-0.045em] text-balance text-ink">
            A team in every space.
          </h2>
          <p className="mt-5 text-[17px] leading-[1.55] text-ink-2">
            Give a space roles that each work toward a goal, on their own schedule, and hand work along to one
            another. Every role wears a Realmite whose face is its run&rsquo;s state, never a mood.
          </p>
          <p className="mt-4 text-[17px] leading-[1.55] text-ink-2">
            What the team makes waits in Review. Nothing is posted, sent or published until you approve it, and
            a team&rsquo;s keys are used under grants only you can set.
          </p>
        </div>

        <div className="spot rounded-[24px] p-4 sm:p-6">
          <div className="flex items-center justify-between px-1">
            <p className="text-[13px] text-ink-2">
              <span className="text-ink">Newsletter</span> · 4 roles
            </p>
            <button
              type="button"
              onClick={shuffle}
              className="app-corner flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[13px] text-ink-2 transition-colors duration-150 hover:bg-raised hover:text-ink"
            >
              <Icon name="reload" className="h-3.5 w-3.5" /> Shuffle
            </button>
          </div>

          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ROLES.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={picked === r.id}
                  onClick={() => setPicked(r.id)}
                  className="flex w-full flex-col items-center gap-2 rounded-[16px] bg-page px-2 pt-5 pb-4 shadow-[inset_0_0_0_1px_var(--color-line)] transition-[box-shadow,background-color] duration-200 hover:bg-surface aria-pressed:bg-surface aria-pressed:shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.55)]"
                >
                  <Realmite spec={specs[r.id]!} size={64} state={states[r.id]} />
                  <span className="text-[13.5px] font-[520] text-ink">{r.name}</span>
                  <span className={`flex items-center gap-1.5 text-[12px] ${stateTone(states[r.id]!)}`}>
                    {states[r.id] === "needs-you" || states[r.id] === "working" ? (
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${states[r.id] === "needs-you" ? "bg-orange" : "bg-green"}`} />
                    ) : null}
                    {stateLabel(states[r.id]!)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div aria-live="polite" className="mt-3 rounded-[14px] bg-page px-4 py-3 text-[13.5px] shadow-[inset_0_0_0_1px_var(--color-line)]">
            <p className="text-ink">{role.goal}</p>
            <p className="mt-1 flex items-center gap-1.5 text-ink-3">
              Hands work to <Icon name="chevronRight" className="h-3 w-3" /> <span className="text-ink-2">{role.handsTo}</span>
            </p>
          </div>

          <div className="mt-5 px-1">
            <p className="flex items-center gap-2 text-[13px] text-ink-2">
              Review
              {waiting.length ? <span className="text-orange">{waiting.length} waiting</span> : <span className="text-ink-3">Nothing waiting</span>}
            </p>
            <ul className="mt-2.5 space-y-2">
              {ITEMS.map((item) => {
                const from = ROLES.find((r) => r.id === item.from)!
                const outcome = decided[item.id]
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-[14px] bg-page px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--color-line)] sm:flex-nowrap">
                    <Realmite spec={specs[from.id]!} size={24} state={outcome ? "idle" : "needs-you"} />
                    <div className="min-w-0 flex-1 basis-[13rem]">
                      <p className="truncate text-[13.5px] text-ink">{item.title}</p>
                      <p className="truncate text-[12px] text-ink-3">
                        {from.name} · {item.detail}
                      </p>
                    </div>
                    {outcome ? (
                      <span className={`ml-9 flex items-center gap-1 text-[12.5px] sm:ml-0 ${outcome === "approved" ? "text-green" : "text-ink-2"}`}>
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
                      <span className="ml-9 flex gap-1.5 sm:ml-0">
                        <button
                          type="button"
                          onClick={() => setDecided((d) => ({ ...d, [item.id]: "returned" }))}
                          className="app-corner rounded-[9px] px-2.5 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-raised hover:text-ink"
                        >
                          Send back
                        </button>
                        <button
                          type="button"
                          onClick={() => setDecided((d) => ({ ...d, [item.id]: "approved" }))}
                          className="app-corner rounded-[9px] bg-accent-fill px-2.5 py-1.5 text-[12.5px] text-white transition-[background-color,scale] hover:bg-accent-fill-hover active:bg-accent-fill-press active:scale-[0.97]"
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

const stateLabel = (s: RealmiteState) => (s === "needs-you" ? "Needs you" : s === "working" ? "Working" : s === "sleeping" ? "Done for today" : "Idle")
const stateTone = (s: RealmiteState) => (s === "needs-you" ? "text-orange" : s === "working" ? "text-green" : "text-ink-3")

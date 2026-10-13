"use client"

import { useMemo, useState } from "react"

import { Icon } from "@/components/home/mini/icons"
import { FieldPanel } from "@/components/realms/FieldPanel"
import { FIELD_PATTERN, TILE } from "@/components/realms/hive/fallback"
import { Realmite, realmiteFromSeed, type RealmiteSpec, type RealmiteState } from "@/lib/realmite"

type Role = { id: string; name: string; goal: string; handsTo: string; seed: string }
type Item = { id: string; title: string; from: string; detail: string }

/** The board's roles and Review, as the landing page's Teams section has them. */
export const ROLES: Role[] = [
  { id: "researcher", name: "Researcher", goal: "Find three stories a week the audience hasn't seen yet.", handsTo: "Content Producer", seed: "realm-researcher-7" },
  { id: "producer", name: "Content Producer", goal: "Turn each story into a newsletter and a set of posts.", handsTo: "Editor", seed: "realm-producer-2" },
  { id: "editor", name: "Editor", goal: "Hold every draft to the style guide before it reaches you.", handsTo: "You, in Review", seed: "realm-editor-11" },
  { id: "ops", name: "Ops", goal: "Keep the calendar, the accounts and the week's budget straight.", handsTo: "Researcher", seed: "realm-ops-4" },
]

const ITEMS: Item[] = [
  { id: "newsletter", title: "Thursday's newsletter", from: "editor", detail: "1,240 words · 3 stories · links checked" },
  { id: "posts", title: "Three posts for the launch", from: "producer", detail: "Scheduled for 4:10 PM, after you approve" },
]

/** The size the world's Realmites are drawn at before the field scales them to their distance. */
export const WORLD_REALMITE = 64

/**
 * Teams (2.1), as a place: the team's four realms stand together in the field with each role's
 * Realmite at its door, and the board beside them is the one the app shows. Picking a role lights its
 * doorway; what is waiting in Review shows on its role's face, never as a mood. The Realmites at the
 * doors are the app's own generator, the same seeds as the board's, positioned every frame by the
 * field from the doorway they stand at.
 */
export function Team({ side }: { side: "left" | "right" }) {
  const [specs, setSpecs] = useState<Record<string, RealmiteSpec>>(() =>
    Object.fromEntries(ROLES.map((r) => [r.id, realmiteFromSeed(r.seed)])),
  )
  const [picked, setPicked] = useState("editor")
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

  const role = ROLES.find((r) => r.id === picked)!
  const textCols = side === "right" ? "lg:col-start-1 lg:col-end-6" : "lg:col-start-7 lg:col-end-13"
  const slotCols = side === "right" ? "lg:col-start-6 lg:col-end-13" : "lg:col-start-1 lg:col-end-7"

  return (
    <section aria-labelledby="teams-title" className="relative">
      <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 gap-y-10 px-6 py-24 sm:px-10 lg:min-h-[150vh] lg:grid-cols-12 lg:items-center lg:gap-x-8 lg:py-0">
        <FieldPanel anchor="k:teams" wrapClassName={`z-[2] min-w-0 lg:row-start-1 ${textCols}`} className="px-5 pt-7 pb-5 sm:px-7 sm:pt-8 sm:pb-6">
          <p className="flex items-center gap-2 text-[13px] text-accent-ink">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            New in Realm 2.1
          </p>
          <h2 id="teams-title" className="mt-4 text-[clamp(1.9rem,2.9vw,2.6rem)] leading-[1.06] font-[580] tracking-[-0.04em] text-balance text-ink">
            A team in every space.
          </h2>
          <p className="mt-5 max-w-[34rem] text-[17px] leading-[1.6] text-ink-2">
            Give a space roles that each work toward a goal, on their own schedule, and hand work along to one another.
            Every role wears a Realmite whose face is its run&rsquo;s state, never a mood. What the team makes waits in
            Review, and nothing is posted, sent or published until you approve it.
          </p>

          <div className="spot mt-8 p-4" style={{ borderRadius: 12 }}>
            <div className="flex items-center justify-between px-1">
              <p className="text-[13px] text-ink-2">
                <span className="text-ink">Newsletter</span> · 4 roles
              </p>
              <button
                type="button"
                onClick={shuffle}
                className="btn btn-ghost app-corner flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[13px]"
              >
                <Icon name="reload" className="turn h-3.5 w-3.5" /> Shuffle
              </button>
            </div>

            <ul className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ROLES.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={picked === r.id}
                    onClick={() => setPicked(r.id)}
                    className="flex w-full flex-col items-center gap-1.5 rounded-[12px] bg-page px-2 pt-4 pb-3 shadow-[inset_0_0_0_1px_var(--color-line)] transition-[box-shadow,background-color] duration-150 ease-out hover:bg-surface hover:duration-220 hover:ease-spring aria-pressed:bg-surface aria-pressed:shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.55)]"
                  >
                    <Realmite spec={specs[r.id]!} size={48} state={states[r.id]} />
                    <span className="text-[13px] font-[520] text-ink">{r.name}</span>
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

            <div aria-live="polite" className="mt-2.5 rounded-[12px] bg-page px-3.5 py-2.5 text-[13.5px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              <p className="text-ink">{role.goal}</p>
              <p className="mt-1 flex items-center gap-1.5 text-ink-2">
                Hands work to <Icon name="chevronRight" className="h-3 w-3" /> <span className="text-ink">{role.handsTo}</span>
              </p>
            </div>

            <div className="mt-4 px-1">
              <p className="flex items-center gap-2 text-[13px] text-ink-2">
                Review
                {waiting.length ? <span className="text-orange">{waiting.length} waiting</span> : <span className="text-ink-2">Nothing waiting</span>}
              </p>
              <ul className="mt-2 space-y-2">
                {ITEMS.map((item) => {
                  const from = ROLES.find((r) => r.id === item.from)!
                  const outcome = decided[item.id]
                  return (
                    <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-[12px] bg-page px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)] sm:flex-nowrap">
                      <Realmite spec={specs[from.id]!} size={24} state={outcome ? "idle" : "needs-you"} />
                      <div className="min-w-0 flex-1 basis-[12rem]">
                        <p className="truncate text-[13.5px] text-ink">{item.title}</p>
                        <p className="truncate text-[12px] text-ink-2">
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
                            className="ml-2 text-ink-2 underline decoration-line-strong underline-offset-2 transition-colors duration-150 ease-out hover:text-ink hover:decoration-current hover:duration-220 hover:ease-spring"
                          >
                            Undo
                          </button>
                        </span>
                      ) : (
                        <span className="ml-9 flex gap-1.5 sm:ml-0">
                          <button
                            type="button"
                            onClick={() => setDecided((d) => ({ ...d, [item.id]: "returned" }))}
                            className="btn btn-ghost app-corner rounded-[8px] px-2.5 py-1.5 text-[12.5px]"
                          >
                            Send back
                          </button>
                          <button
                            type="button"
                            onClick={() => setDecided((d) => ({ ...d, [item.id]: "approved" }))}
                            className="btn btn-accent app-corner rounded-[8px] px-2.5 py-1.5 text-[12.5px]"
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
        </FieldPanel>

        {/* Where the team's realms stand in the field. Without the field it holds nothing, and the
            board beside it carries the whole of the section. */}
        <div data-field-anchor="s:teams" aria-hidden className={`relative hidden aspect-[3/2] min-w-0 lg:row-start-1 lg:block ${slotCols}`}>
          {/* Without the field: the Hive's still drawing of it, a calm plate of realms. */}
          <div
            className="absolute inset-0 hidden [mask-image:radial-gradient(closest-side,black_35%,transparent)] [html[data-field=off]_&]:block"
            style={{ backgroundImage: FIELD_PATTERN, backgroundSize: `${TILE.width}px ${TILE.height}px`, backgroundPosition: "center" }}
          />
        </div>
      </div>

      {/* The Realmites at their doors, placed by the field. */}
      <div aria-hidden className="pointer-events-none">
        {ROLES.map((r) => (
          <div
            key={r.id}
            data-realmite={r.id}
            data-state={states[r.id]}
            data-picked={picked === r.id ? "" : undefined}
            className="invisible fixed top-0 left-0 z-[1] origin-top-left opacity-0"
            style={{ width: WORLD_REALMITE, height: WORLD_REALMITE }}
          >
            <Realmite spec={specs[r.id]!} size={WORLD_REALMITE} state={states[r.id]} />
          </div>
        ))}
      </div>
    </section>
  )
}

const stateLabel = (s: RealmiteState) => (s === "needs-you" ? "Needs you" : s === "working" ? "Working" : s === "sleeping" ? "Done for today" : "Idle")
const stateTone = (s: RealmiteState) => (s === "needs-you" ? "text-orange" : s === "working" ? "text-green" : "text-ink-2")

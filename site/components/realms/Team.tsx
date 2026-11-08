"use client"

import { useState } from "react"

import { FieldPanel } from "@/components/realms/FieldPanel"
import { FIELD_PATTERN, TILE } from "@/components/realms/hive/fallback"
import { TeammateIcon, type TeammateIconSpec } from "@/lib/teammate-icon/TeammateIcon"

type State = "idle" | "working" | "needs-you"
type Task = { title: string; ago: string; asks?: string }
type Teammate = { id: string; name: string; brief: string; icon: TeammateIconSpec; lead?: boolean; resting: State; task?: Task }

/** Four of the app's quick starts (panes/teammate/quick-starts.ts), with their shapes and colours. */
export const ROLES: Teammate[] = [
  { id: "lead", name: "Lead", brief: "Hands each ask to the teammate who fits, and comes back with finished work.", icon: { shape: "circle", hue: 264, chroma: 0.014 }, lead: true, resting: "idle" },
  { id: "cto", name: "CTO", brief: "Owns the technical direction: architecture, data and performance.", icon: { shape: "hexagon", hue: 260, chroma: 0.15 }, resting: "working", task: { title: "cto - sqlite search", ago: "4m" } },
  { id: "design", name: "Design engineer", brief: "Builds and polishes the interface, and checks it in the running app.", icon: { shape: "flower", hue: 350, chroma: 0.15 }, resting: "needs-you", task: { title: "design-engineer - settings page", ago: "1m", asks: "Allow Bash?" } },
  { id: "research", name: "Research", brief: "Finds things out, and changes nothing in the project unless you ask.", icon: { shape: "cloud", hue: 188, chroma: 0.106 }, resting: "idle", task: { title: "research - sync engines", ago: "2h" } },
]

/** The size a figure in the world is drawn at before the field scales it to its distance. */
export const WORLD_ICON = 64

/**
 * Teams, as a place: four realms stand together in the field with a teammate's icon at each door, and
 * the list beside them acts out what the app's does. Picking a teammate lights its doorway. An icon
 * says who; state is the words and the dot beside it. The figures at the doors are positioned every
 * frame by the field from the doorway they stand at.
 */
export function Team({ side }: { side: "left" | "right" }) {
  const [picked, setPicked] = useState("design")
  const [answer, setAnswer] = useState<"allowed" | "denied" | null>(null)

  const stateOf = (t: Teammate): State => {
    if (t.resting !== "needs-you" || !answer) return t.resting
    return answer === "allowed" ? "working" : "idle"
  }
  const teammate = ROLES.find((t) => t.id === picked)!
  const textCols = side === "right" ? "lg:col-start-1 lg:col-end-6" : "lg:col-start-7 lg:col-end-13"
  const slotCols = side === "right" ? "lg:col-start-6 lg:col-end-13" : "lg:col-start-1 lg:col-end-7"
  const task = teammate.task

  return (
    <section aria-labelledby="teams-title" className="relative">
      <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 gap-y-10 px-6 py-24 sm:px-10 lg:min-h-[150vh] lg:grid-cols-12 lg:items-center lg:gap-x-8 lg:py-0">
        <FieldPanel anchor="k:teams" wrapClassName={`z-[2] min-w-0 lg:row-start-1 ${textCols}`} className="px-5 pt-7 pb-5 sm:px-7 sm:pt-8 sm:pb-6">
          <h2 id="teams-title" className="text-[clamp(1.9rem,2.9vw,2.6rem)] leading-[1.06] font-[580] tracking-[-0.04em] text-balance text-ink">
            A team in every space.
          </h2>
          <p className="mt-5 max-w-[34rem] text-[17px] leading-[1.6] text-ink-2">
            A teammate is an agent that stays in a space, with a name, a job, a model and one chat you come back to. For
            real work it starts sessions of its own, it can message the other teammates, and it can check in on a
            schedule. It runs in the permission mode you give it.
          </p>

          <div className="spot mt-8 p-4" style={{ borderRadius: 12 }}>
            <p className="px-1 text-[13px] text-ink-2">
              <span className="text-ink">Site</span> · {ROLES.length} teammates
            </p>

            <ul className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ROLES.map((t) => {
                const state = stateOf(t)
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-pressed={picked === t.id}
                      onClick={() => setPicked(t.id)}
                      className="flex w-full flex-col items-center gap-1.5 rounded-[12px] bg-page px-2 pt-4 pb-3 shadow-[inset_0_0_0_1px_var(--color-line)] transition-[box-shadow,background-color] duration-150 ease-out hover:bg-surface hover:duration-220 hover:ease-spring aria-pressed:bg-surface aria-pressed:shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.55)]"
                    >
                      <TeammateIcon icon={t.icon} size={48} lead={t.lead} />
                      <span className="text-[13px] font-[520] text-ink">{t.name}</span>
                      <span className={`flex items-center gap-1.5 text-[12px] ${stateTone(state)}`}>
                        {state !== "idle" ? <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state === "needs-you" ? "bg-orange" : "bg-green"}`} /> : null}
                        {stateLabel(state)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>

            <div aria-live="polite" className="mt-2.5 rounded-[12px] bg-page px-3.5 py-2.5 text-[13.5px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              <p className="text-ink">{teammate.brief}</p>
            </div>

            <div className="mt-4 px-1">
              <p className="text-[13px] text-ink-2">Its sessions</p>
              {task ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 rounded-[12px] bg-page px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)] sm:flex-nowrap">
                  <div className="min-w-0 flex-1 basis-[12rem]">
                    <p className="truncate text-[13.5px] text-ink">{task.title}</p>
                    <p className="truncate text-[12px] text-ink-2">
                      {task.ago} ago{task.asks && !answer ? ` · ${task.asks}` : ""}
                    </p>
                  </div>
                  {task.asks ? (
                    answer ? (
                      <span className="text-[12.5px] text-ink-2">{answer === "allowed" ? "Allowed" : "Denied"}</span>
                    ) : (
                      <span className="flex gap-1.5">
                        <button type="button" onClick={() => setAnswer("denied")} className="btn btn-ghost app-corner rounded-[8px] px-2.5 py-1.5 text-[12.5px]">
                          Deny
                        </button>
                        <button type="button" onClick={() => setAnswer("allowed")} className="btn btn-accent app-corner rounded-[8px] px-2.5 py-1.5 text-[12.5px]">
                          Allow
                        </button>
                      </span>
                    )
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 rounded-[12px] bg-page px-3 py-2.5 text-[13.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
                  It passes the work on, so the sessions are its teammates&rsquo;.
                </p>
              )}
            </div>
          </div>
        </FieldPanel>

        {/* Where the team's realms stand in the field. Without the field it holds nothing, and the
            list beside it carries the whole of the section. */}
        <div data-field-anchor="s:teams" aria-hidden className={`relative hidden aspect-[3/2] min-w-0 lg:row-start-1 lg:block ${slotCols}`}>
          {/* Without the field: the Hive's still drawing of it, a calm plate of realms. */}
          <div
            className="absolute inset-0 hidden [mask-image:radial-gradient(closest-side,black_35%,transparent)] [html[data-field=off]_&]:block"
            style={{ backgroundImage: FIELD_PATTERN, backgroundSize: `${TILE.width}px ${TILE.height}px`, backgroundPosition: "center" }}
          />
        </div>
      </div>

      {/* The teammates at their doors, placed by the field. */}
      <div aria-hidden className="pointer-events-none">
        {ROLES.map((t) => (
          <div
            key={t.id}
            data-teammate={t.id}
            data-state={stateOf(t)}
            data-picked={picked === t.id ? "" : undefined}
            className="invisible fixed top-0 left-0 z-[1] origin-top-left opacity-0"
            style={{ width: WORLD_ICON, height: WORLD_ICON }}
          >
            <TeammateIcon icon={t.icon} size={WORLD_ICON} lead={t.lead} />
          </div>
        ))}
      </div>
    </section>
  )
}

const stateLabel = (s: State) => (s === "needs-you" ? "Needs you" : s === "working" ? "Working" : "Idle")
const stateTone = (s: State) => (s === "needs-you" ? "text-orange" : s === "working" ? "text-green" : "text-ink-2")

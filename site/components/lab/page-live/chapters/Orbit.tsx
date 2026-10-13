"use client"

import { useRef, useState, type PointerEvent } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"

import { Instrument } from "../kit/Chapter"
import { useScrollProgress } from "../kit/hooks"

/** The three tasks the schedules capture shows, on the days and times it shows them. */
const TASKS: { id: string; name: string; when: string; agent: AgentId; model: string; runs: number[]; r: number }[] = [
  { id: "triage", name: "Morning triage", when: "Weekdays 9:00 AM", agent: "openai", model: "GPT-6 Luna", runs: [0, 1, 2, 3, 4].map((d) => d * 24 + 9), r: 0.4 },
  { id: "sweep", name: "Dependency sweep", when: "Mondays 7:00 AM", agent: "claude", model: "Sonnet 5", runs: [7], r: 0.6 },
  { id: "numbers", name: "Weekly numbers", when: "Fridays 4:00 PM", agent: "claude", model: "Opus 5.5", runs: [4 * 24 + 16], r: 0.8 },
]
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const WEEK = 168

const round = (n: number) => Math.round(n * 1000) / 1000

const stamp = (h: number) => {
  const day = DAYS[Math.floor(h / 24) % 7]
  const hour = Math.floor(h % 24)
  const twelve = hour % 12 || 12
  return `${day} ${twelve}:00 ${hour < 12 ? "AM" : "PM"}`
}

/**
 * Work that outlives the window: a week as a dial, realm-server at its centre, each scheduled task on
 * an orbit with its runs marked. Scrolling turns the week; each run fires as the hand passes it and
 * becomes a session in the list. Close the window and the week keeps turning, because realm-server
 * keeps running without it.
 */
export function Orbit() {
  const dialRef = useRef<HTMLDivElement>(null)
  const progress = useScrollProgress(dialRef, { from: 0.85, to: 0.05 })
  const [manual, setManual] = useState<number | null>(null)
  const [closed, setClosed] = useState(false)
  const hours = manual ?? progress * WEEK * 0.999

  const runs = TASKS.flatMap((t) => t.runs.filter((h) => h <= hours).map((h) => ({ task: t, h }))).sort((a, b) => b.h - a.h)

  const setFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const dx = event.clientX - (box.left + box.width / 2)
    const dy = event.clientY - (box.top + box.height / 2)
    const a = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1
    setManual(a * WEEK)
  }

  const angle = (h: number) => (h / WEEK) * Math.PI * 2
  // Rounded, so the server's trigonometry and the browser's agree to the character when it hydrates.
  const polar = (h: number, r: number): [number, number] => [round(50 + Math.sin(angle(h)) * r * 50), round(50 - Math.cos(angle(h)) * r * 50)]

  return (
    <Instrument
      kind="Diagram"
      caption="A week of scheduled tasks. Scroll to turn it, or drag the hand."
      controls={
        <button
          type="button"
          aria-pressed={closed}
          onClick={() => setClosed((c) => !c)}
          className="app-corner rounded-[9px] bg-canvas px-3 py-1.5 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-raised hover:text-ink"
        >
          {closed ? "Open the window again" : "Close the window"}
        </button>
      }
    >
      <div className="grid gap-8 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] sm:items-center">
        <div
          ref={dialRef}
          role="slider"
          tabIndex={0}
          aria-label="The time of the week"
          aria-valuemin={0}
          aria-valuemax={WEEK}
          aria-valuenow={Math.round(hours)}
          aria-valuetext={stamp(hours)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 3 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -3 : 0
            if (!step) return
            e.preventDefault()
            e.stopPropagation()
            setManual(Math.min(WEEK - 0.01, Math.max(0, hours + step)))
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            setFromPointer(e)
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromPointer(e)
          }}
          className="relative mx-auto mb-14 aspect-square w-full max-w-[30rem] cursor-grab touch-none rounded-full outline-offset-4 select-none active:cursor-grabbing sm:mb-12"
        >
          <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible" fill="none">
            {/* The week: a tick for each day, a finer one every six hours. */}
            <circle cx={50} cy={50} r={48} stroke="oklch(1 0 0 / 0.16)" strokeWidth={0.25} vectorEffect="non-scaling-stroke" />
            {Array.from({ length: 28 }, (_, i) => {
              const day = i % 4 === 0
              const [x1, y1] = polar(i * 6, day ? 0.9 : 0.93)
              const [x2, y2] = polar(i * 6, 0.96)
              return <path key={i} d={`M${x1} ${y1}L${x2} ${y2}`} stroke={day ? "oklch(1 0 0 / 0.45)" : "oklch(1 0 0 / 0.18)"} vectorEffect="non-scaling-stroke" />
            })}
            {TASKS.map((t) => (
              <g key={t.id}>
                <circle cx={50} cy={50} r={t.r * 50} stroke="oklch(1 0 0 / 0.2)" vectorEffect="non-scaling-stroke" />
                {t.runs.map((h) => {
                  const [cx, cy] = polar(h, t.r)
                  const fired = h <= hours
                  // A step the hand has just passed rings once as it fires.
                  const since = hours - h
                  const ring = fired && since < 7 ? since / 7 : null
                  return (
                    <g key={h}>
                      {ring !== null ? <circle cx={cx} cy={cy} r={1.3 + ring * 4.5} stroke="var(--color-accent-ink)" strokeOpacity={(1 - ring) * 0.8} vectorEffect="non-scaling-stroke" /> : null}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={1.3}
                        fill={fired ? "var(--color-accent)" : "var(--color-page)"}
                        stroke={fired ? "var(--color-accent)" : "oklch(1 0 0 / 0.55)"}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  )
                })}
              </g>
            ))}
            {/* The hand: now. */}
            {(() => {
              const [x, y] = polar(hours, 0.96)
              const [x0, y0] = polar(hours, 0.16)
              return (
                <>
                  <path d={`M${x0} ${y0}L${x} ${y}`} stroke="var(--color-accent-ink)" vectorEffect="non-scaling-stroke" />
                  <circle cx={x} cy={y} r={1.4} fill="var(--color-accent-ink)" />
                </>
              )
            })()}
            <circle cx={50} cy={50} r={8} fill="var(--color-page)" stroke="oklch(1 0 0 / 0.5)" vectorEffect="non-scaling-stroke" />
          </svg>
          {DAYS.map((d, i) => {
            const [x, y] = polar(i * 24 + 12, 1.08)
            return (
              <span key={d} aria-hidden style={{ left: `${x}%`, top: `${y}%` }} className="absolute -translate-x-1/2 -translate-y-1/2 text-[11.5px] text-ink-3">
                {d}
              </span>
            )
          })}
          <span aria-hidden className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[11.5px] leading-[1.25] text-ink-2">
            realm
            <br />
            server
          </span>
          {/* Each track's head: the agent that runs it, where the week begins. */}
          {TASKS.map((t) => {
            const [x, y] = polar(0, t.r)
            return (
              <span key={t.id} aria-hidden style={{ left: `${x}%`, top: `${y}%` }} className="absolute grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-page text-ink-2 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.25)]">
                <AgentMark id={t.agent} className="size-3" />
              </span>
            )
          })}
          <span aria-live="polite" className="absolute top-full left-1/2 mt-6 flex -translate-x-1/2 items-center gap-3 font-mono text-[12px] whitespace-nowrap text-ink-2">
            {stamp(hours)}
            <span className={`flex items-center gap-1.5 font-sans text-[12.5px] ${closed ? "text-ink-3" : "text-ink-2"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${closed ? "bg-ink-3/60" : "bg-green"}`} />
              {closed ? "Window closed" : "Window open"}
            </span>
          </span>
        </div>

        <div>
          <ul className="space-y-2.5">
            {TASKS.map((t) => (
              <li key={t.id} className="flex items-center gap-2.5 text-[13px]">
                <span className="grid size-6 shrink-0 place-items-center rounded-full text-ink-2 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.22)]">
                  <AgentMark id={t.agent} className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{t.name}</span>
                  <span className="block text-[12px] text-ink-3">
                    {t.when} · {t.model}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-6 border-t border-line pt-4">
            <p className="flex items-baseline justify-between text-[12.5px] text-ink-2">
              Runs this week
              <span className="font-mono text-[11.5px] text-ink-3">{runs.length}</span>
            </p>
            <ul aria-live="polite" className="mt-2.5 min-h-[9.5rem] space-y-1.5">
              {runs.slice(0, 5).map(({ task, h }, i) => (
                <li key={`${task.id}-${h}`} className={`flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] ${i === 0 ? "bg-raised/70 text-ink" : "text-ink-2"}`}>
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 truncate">{task.name}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-3">{stamp(h)}</span>
                </li>
              ))}
              {!runs.length ? <li className="px-2 py-1.5 text-[12.5px] text-ink-3">Nothing has run yet this week.</li> : null}
            </ul>
            <p className="mt-3 text-[12.5px] leading-[1.5] text-ink-3">
              {closed ? "The window is closed, and the runs still happen: realm-server keeps going without it." : "Every run is a real session you can open, read and pick up from."}
            </p>
          </div>
        </div>
      </div>
    </Instrument>
  )
}

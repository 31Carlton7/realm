"use client"

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

import { AgentMark } from "@/components/AgentMark"
import { Icon } from "@/components/home/mini/icons"

import { useAnchors } from "../kit/anchors"
import { useScrollProgress } from "../kit/hooks"
import { Instrument } from "../kit/Chapter"

type Edit = { path: string; file: string; plus: number; minus: number }
type Turn = { at: string; asked: string; answered: string; edits: Edit[]; ran?: string }

/**
 * A sample session's turns. What the drawing claims is the app's own rule for Undo: it shows only
 * when a checkpoint can take back exactly that turn and nothing after it, and restoring one puts the
 * files back and, for Claude, rewinds the conversation too.
 */
const TURNS: Turn[] = [
  {
    at: "11:02",
    asked: "Please fix the org access crash. It only happens on staging.",
    answered: "Fixed the org access crash path. The important change is in web/lib/orgs.ts.",
    edits: [
      { path: "web/lib/", file: "orgs.ts", plus: 17, minus: 2 },
      { path: "web/lib/agent/compaction/", file: "auto-compact.ts", plus: 3, minus: 1 },
    ],
  },
  { at: "11:09", asked: "Why did it only crash on staging?", answered: "The invite metadata drifts between environments, and selecting it is what crashed.", edits: [] },
  {
    at: "11:15",
    asked: "Write tests for the changes.",
    answered: "Added six cases for getOrgMembership() and canAccessProject().",
    edits: [{ path: "web/lib/", file: "orgs.test.ts", plus: 64, minus: 0 }],
  },
  { at: "11:18", asked: "Run them.", answered: "All six pass.", edits: [], ran: "pnpm vitest run web/lib/orgs" },
  {
    at: "11:26",
    asked: "Rename getOrgMembership to findMembership.",
    answered: "Renamed it in the three files that call it.",
    edits: [
      { path: "web/lib/", file: "orgs.ts", plus: 4, minus: 4 },
      { path: "web/lib/", file: "access.ts", plus: 2, minus: 2 },
      { path: "web/lib/", file: "orgs.test.ts", plus: 3, minus: 3 },
    ],
  },
  { at: "11:31", asked: "Summarize the changes for the pull request.", answered: "Two fixes and a rename, with tests. Here's a summary you can paste.", edits: [] },
]

/** Whether a checkpoint can take back exactly this turn: it changed files, and no turn after it did. */
const undoable = (turns: Turn[], i: number) => turns[i]!.edits.length > 0 && turns.slice(i + 1).every((t) => !t.edits.length)

export function Timeline() {
  const [count, setCount] = useState(TURNS.length)
  const [held, setHeld] = useState<number | null>(null)
  const [rewound, setRewound] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const { width } = useAnchors(trackRef)
  // Until the reader takes the playhead, scrolling walks it from the first turn to the fifth, so the
  // card under it shows Undo arriving only where the rule allows it.
  const scrolled = useScrollProgress(trackRef, { from: 0.8, to: 0.3 })
  const picked = held ?? Math.min(count - 1, Math.round(scrolled * 4))
  const setPicked = (i: number) => setHeld(i)
  const turns = TURNS.slice(0, count)
  const turn = turns[picked]!
  const canUndo = undoable(turns, picked)
  const blocker = turn.edits.length ? turns.findIndex((t, i) => i > picked && t.edits.length) : -1

  const W = width || 800
  const pad = 22
  const step = (W - pad * 2) / TURNS.length
  const tickX = (i: number) => pad + step * (i + 0.5)
  const checkX = (i: number) => pad + step * i

  const pickAt = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect()
    if (!box) return
    const i = Math.floor((clientX - box.left - pad) / step)
    setPicked(Math.min(count - 1, Math.max(0, i)))
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    pickAt(event.clientX)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) pickAt(event.clientX)
  }
  const onKey = (event: KeyboardEvent) => {
    const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? picked + 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? picked - 1 : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null
    if (next === null) return
    // The keys move this playhead and nothing else on the page.
    event.preventDefault()
    event.stopPropagation()
    setPicked(Math.min(count - 1, Math.max(0, next)))
  }
  const undo = () => {
    setRewound(picked)
    setCount(picked)
    setPicked(Math.max(0, picked - 1))
  }
  const reset = () => {
    setRewound(null)
    setCount(TURNS.length)
    setHeld(TURNS.length - 2)
  }

  return (
    <Instrument
      kind="Sample"
      caption="One session's turns, left to right. Scroll, or drag along them, or use the arrow keys."
      controls={
        rewound !== null ? (
          <button type="button" onClick={reset} className="text-[12.5px] text-accent-ink underline decoration-accent-ink/40 underline-offset-[3px] hover:decoration-accent-ink">
            Put the sample back
          </button>
        ) : null
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="text-[oklch(0.72_0.15_250)]">
          <Icon name="grid" className="h-3.5 w-3.5" />
        </span>
        <span className="text-ink-2">Dashboard</span>
        <Icon name="chevronRight" className="h-3 w-3 text-ink-3" />
        <span className="text-ink">Fix the org access crash</span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
          <AgentMark id="claude" className="h-3 w-3" /> Claude · Opus 5.5
        </span>
      </div>

      {/* The track: a tick per turn, a dot where the turn changed files, a checkpoint between turns. */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Turn"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={picked + 1}
        aria-valuetext={`Turn ${picked + 1} of ${count}: ${turn.asked}`}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        className="relative h-[92px] cursor-ew-resize touch-pan-y rounded-[10px] outline-offset-2 select-none"
      >
        <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" fill="none">
          <path d={`M${pad} 46H${W - pad}`} stroke="oklch(1 0 0 / 0.22)" />
          {TURNS.map((t, i) => {
            const gone = i >= count
            const x = tickX(i)
            const edited = t.edits.length > 0
            return (
              <g key={i} opacity={gone ? 0.18 : 1} className="transition-opacity duration-500">
                {/* The checkpoint that brackets the turn's start. */}
                <path
                  d={`M${checkX(i) + 4} 36H${checkX(i)}V56H${checkX(i) + 4}`}
                  stroke={rewound === i ? "var(--color-accent)" : "oklch(1 0 0 / 0.38)"}
                  strokeWidth={rewound === i ? 1.5 : 1}
                />
                <path d={`M${x} 46V${edited ? 30 : 36}`} stroke={i === picked ? "var(--color-ink)" : "oklch(1 0 0 / 0.55)"} strokeWidth={1.25} />
                {edited ? <circle cx={x} cy={27} r={2.75} fill={i === picked ? "var(--color-ink)" : "oklch(1 0 0 / 0.6)"} /> : null}
              </g>
            )
          })}
          {/* The last checkpoint, after the newest turn. */}
          <path d={`M${checkX(count) - 4} 36H${checkX(count)}V56H${checkX(count) - 4}`} stroke="oklch(1 0 0 / 0.38)" />
          {/* The turn under the playhead, lit between the two checkpoints that bracket it. */}
          <path d={`M${checkX(picked) + 1} 46H${checkX(picked + 1) - 1}`} stroke="var(--color-accent)" strokeWidth={2} className="transition-[d] duration-200 motion-reduce:transition-none" />
          {/* The playhead. */}
          <path d={`M${tickX(picked)} 14V92`} stroke="var(--color-accent)" strokeWidth={1} className="transition-[d] duration-200 motion-reduce:transition-none" />
          <circle cx={tickX(picked)} cy={46} r={5} fill="var(--color-page)" stroke="var(--color-accent)" strokeWidth={1.5} />
        </svg>
        {TURNS.map((t, i) => (
          <span
            key={i}
            aria-hidden
            style={{ left: tickX(i) }}
            className={`absolute top-[62px] -translate-x-1/2 font-mono text-[11.5px] transition-colors duration-200 ${i >= count ? "text-ink-3/40" : i === picked ? "text-ink" : "text-ink-3"}`}
          >
            {t.at}
          </span>
        ))}
      </div>

      <div aria-hidden className="mt-1 flex flex-wrap justify-end gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
            <path d="M6 1H2V13H6" stroke="oklch(1 0 0 / 0.5)" />
          </svg>
          checkpoint
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="8" height="14" viewBox="0 0 8 14" fill="none">
            <path d="M4 3V13" stroke="oklch(1 0 0 / 0.6)" strokeWidth="1.25" />
            <circle cx="4" cy="2.5" r="2" fill="oklch(1 0 0 / 0.6)" />
          </svg>
          a turn that changed files
        </span>
      </div>

      {/* What the tick under the playhead holds: the card the app shows for it. */}
      <div aria-live="polite" className="mt-4 rounded-[16px] bg-canvas p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-[12px] text-ink-3">
            Turn {picked + 1} · {turn.at} AM
          </p>
          {turn.edits.length ? <p className="text-[12px] text-ink-3">Edited {turn.edits.length === 1 ? "1 file" : `${turn.edits.length} files`}</p> : null}
        </div>
        <p className="mt-2 text-[15px] leading-[1.5] text-ink">{turn.asked}</p>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-2">{turn.answered}</p>
        {turn.ran ? (
          <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-2">
            <Icon name="terminal" className="h-3.5 w-3.5 text-ink-3" /> Ran <span className="font-mono text-[12px]">{turn.ran}</span>
          </p>
        ) : null}
        {turn.edits.length ? (
          <div className="mt-4 space-y-1.5 rounded-[10px] bg-page/70 p-3.5 text-[12.5px]">
            {turn.edits.map((e) => (
              <p key={e.path + e.file} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-ink-3">
                  {e.path}
                  <span className="text-ink">{e.file}</span>
                </span>
                <span className="font-mono text-[11.5px] text-green">+{e.plus}</span>
                <span className="font-mono text-[11.5px] text-red">−{e.minus}</span>
              </p>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
          {canUndo ? (
            <button
              type="button"
              onClick={undo}
              className="app-corner inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12.5px] text-ink shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.6)] transition-colors hover:bg-raised"
            >
              Undo <Icon name="undo" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <p className="text-[12.5px] leading-[1.5] text-ink-2">
            {canUndo
              ? "Undo is here because nothing after this turn changed a file, so its checkpoint takes back exactly this turn."
              : turn.edits.length && blocker >= 0
                ? `No Undo: turn ${blocker + 1} changed files after this one, so its checkpoint can't take back just this turn.`
                : "Nothing to undo: this turn changed no files."}
          </p>
        </div>
      </div>
      {rewound !== null ? (
        <p className="mt-3 text-[13px] leading-[1.5] text-ink-2">
          Restored the checkpoint before turn {rewound + 1}. The files are back as they were, and because this is Claude, the
          conversation rewound with them.
        </p>
      ) : null}
    </Instrument>
  )
}

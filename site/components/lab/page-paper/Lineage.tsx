"use client"

import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"
import type { Claim, Facet } from "@/content/home"

import { Register, Seam } from "./kinetic"
import s from "./paper.module.css"
import { Plate } from "./Plates"

type Edge = { d: string; key: string; tone: "ink" | "accent" }

/** One member of the family: a name, what it was asked, and where it stands. */
function Member({
  id,
  agent,
  name,
  by,
  children,
  state,
  tone = "ink",
}: {
  id: string
  agent?: AgentId
  name: string
  by?: string
  children?: ReactNode
  state?: ReactNode
  tone?: "ink" | "muted"
}) {
  return (
    <div data-node={id} className={`${s.member} relative min-w-0 lg:text-center`}>
      <p
        className={`inline-flex items-baseline gap-2 text-[19px] leading-[1.3] font-[580] tracking-[-0.018em] ${tone === "ink" ? "text-ink" : "text-ink-2"}`}
      >
        {agent ? <AgentMark id={agent} className="h-[0.8em] w-[0.8em] shrink-0 translate-y-[0.06em] text-ink-2" /> : null}
        <span>{name}</span>
        {by ? <span className="text-[14px] font-[450] tracking-normal text-ink-2">{by}</span> : null}
      </p>
      {children ? <p className="mt-1.5 max-w-[34ch] text-[16px] leading-[1.5] text-ink-2 lg:mx-auto">{children}</p> : null}
      {state ? <p className={`${s.note} mt-2`}>{state}</p> : null}
    </div>
  )
}

/** Who started whom, by node id; and the report that comes back up. */
const PARENT: Record<string, string> = { opus: "you", luna: "opus", fable: "opus", deep: "fable", end: "deep" }

/**
 * The delegation, as a family tree that grows as it is read. The first two generations are the run in
 * the delegation capture under it (the same models, tasks and states); the third shows the limit,
 * which the capture does not reach, and the line ends there with a genealogist's terminating rule.
 * The four sentences beside it are the delegation's own account, each set level with the generation
 * it describes.
 *
 * The rules are routed from where the names actually are, measured, so they meet them at every width,
 * and each is drawn from its parent down as the reader reaches it. The report comes back up the same
 * way in the accent, from the sub-agent that finished to the agent that asked.
 */
export function Lineage({ claim, beats }: { claim: Claim | undefined; beats: Facet[] }) {
  const [start, several, deep, back] = beats
  const tree = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<Edge[]>([])
  const [box, setBox] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const root = tree.current
    if (!root) return
    const route = () => {
      const r = root.getBoundingClientRect()
      const at = (id: string) => root.querySelector<HTMLElement>(`[data-node="${id}"]`)?.getBoundingClientRect()
      const wide = window.matchMedia("(min-width: 1024px)").matches
      // Where a rule leaves a parent and meets a child: centred under and over the name on a wide
      // screen, down the names' left edge (an indented register) on a narrow one.
      const x = (b: DOMRect) => (wide ? b.left + b.width / 2 : b.left - 14) - r.left
      const next: Edge[] = []
      for (const [child, parent] of Object.entries(PARENT)) {
        const c = at(child)
        const p = at(parent)
        if (!c || !p) continue
        const x1 = x(p)
        const y1 = p.bottom - r.top + 10
        const x2 = x(c)
        const y2 = wide ? c.top - r.top - 10 : c.top - r.top + 12
        const mid = (y1 + y2) / 2
        next.push({
          key: child,
          tone: "ink",
          d: Math.abs(x1 - x2) < 1 ? `M${x1} ${y1}V${y2}` : wide ? `M${x1} ${y1}V${mid}H${x2}V${y2}` : `M${x1} ${y1}V${y2}H${x2 + 10}`,
        })
      }
      // The report: up from the sub-agent that finished, beside its rules, to the agent that asked.
      const fable = at("fable")
      const opus = at("opus")
      if (fable && opus && wide) {
        const x1 = x(fable) + 14
        const y1 = fable.top - r.top - 10
        const x2 = x(opus) + 14
        const y2 = opus.bottom - r.top + 16
        const mid = (opus.bottom + fable.top) / 2 - r.top + 8
        next.push({ key: "report", tone: "accent", d: `M${x1} ${y1}V${mid}H${x2}V${y2}` })
      }
      setEdges(next)
      setBox({ w: r.width, h: r.height })
    }
    route()
    const observer = new ResizeObserver(route)
    observer.observe(root)
    window.addEventListener("resize", route)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", route)
    }
  }, [])

  return (
    <section data-running-head="Agents handing work on" aria-labelledby="lineage-title" className={s.section}>
      <Seam />
      <div className={`${s.measure} ${s.grid} gap-y-6`}>
        <div className="col-span-12 lg:col-span-7">
          <Register id="lineage-title" text={claim?.title ?? "Hand work to other models."} className={`${s.statement} text-ink`} />
        </div>
        <p className={`${s.body} col-span-12 max-w-[60ch] lg:col-span-5 lg:pt-3`}>{claim?.body}</p>
      </div>

      <figure className={`${s.measure} mt-16 sm:mt-24`} aria-label="Diagram: a session handing work to two sub-agents, one of which hands work on once more">
        <div className={s.grid}>
          <div className="col-span-12 grid content-start gap-y-10 lg:col-span-4 lg:gap-y-0">
            <Beat beat={start} className="lg:h-[19rem]" />
            <Beat beat={several} className="lg:h-[14rem]" />
            <Beat beat={deep} className="lg:h-[17rem]" />
            <Beat beat={back} />
          </div>

          <div ref={tree} className="relative col-span-12 mt-14 lg:col-span-8 lg:mt-0">
            <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={box.w} height={box.h}>
              <defs>
                {/* A marker's x axis runs along the path, so the head is drawn pointing right. */}
                <marker id="paper-report-head" viewBox="0 0 8 8" refX="6.6" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                  <path d="M1.4 0.9 6.6 4 1.4 7.1" fill="none" stroke="var(--color-accent-ink)" strokeWidth="1.2" />
                </marker>
              </defs>
              {edges.map((edge) => (
                <path
                  key={edge.key}
                  d={edge.d}
                  pathLength={1}
                  className={edge.tone === "accent" ? s.report : s.lineRule}
                  fill="none"
                  stroke={edge.tone === "accent" ? "var(--color-accent-ink)" : "oklch(0.235 0.006 264 / 0.5)"}
                  strokeWidth={edge.tone === "accent" ? 1.5 : 1}
                  markerEnd={edge.tone === "accent" ? "url(#paper-report-head)" : undefined}
                />
              ))}
            </svg>

            <div className="grid gap-y-12 pl-9 lg:gap-y-0 lg:pl-0">
              <div className="grid gap-y-12 lg:h-[19rem] lg:content-start lg:gap-y-16">
                <Member id="you" name="You">
                  Add a dark-mode switch to the app settings, and keep the choice across launches.
                </Member>
                <Member id="opus" agent="claude" name="Claude Opus 5.5" by="this session">
                  Splits the work: the toggle and its tests go to GPT-6 Luna, and the migration to Fable.
                </Member>
              </div>
              <div className="grid gap-y-12 pl-9 lg:h-[14rem] lg:grid-cols-2 lg:content-start lg:gap-x-10 lg:pt-10 lg:pl-0">
                <Member id="luna" agent="openai" name="GPT-6 Luna" by="Codex" state={<><span className="text-orange">Needs you</span> · Allow Bash?</>}>
                  The toggle in Settings ▸ App, and its tests.
                </Member>
                <Member id="fable" agent="claude" name="Claude Fable 5.1" by="Claude" state={<><span className="text-green">Done</span> · its report is back</>}>
                  Storing the choice, with a migration.
                </Member>
              </div>
              <div className="grid gap-y-12 pl-[4.5rem] lg:h-[17rem] lg:grid-cols-2 lg:content-start lg:gap-x-10 lg:gap-y-16 lg:pt-14 lg:pl-0">
                <div className="lg:col-start-2">
                  <Member id="deep" name="A sub-agent of its own" tone="muted">
                    It can hand work off once more.
                  </Member>
                </div>
                <div className="lg:col-start-2">
                  <div data-node="end" className="relative lg:text-center">
                    {/* The line ends: a genealogist's terminating rule, where no further generation is allowed. */}
                    <span aria-hidden className={`${s.terminator} block h-px w-5 bg-ink max-lg:-ml-[1.5rem] lg:mx-auto`} />
                    <p className="mt-3 text-[15px] text-ink-2">Past that, Realm says no.</p>
                  </div>
                </div>
              </div>
              <p className={`${s.note} mt-2 max-w-[44ch] lg:mx-auto lg:mt-0 lg:text-center`}>
                <span className="text-accent-ink">Report from Claude Fable 5.1:</span> wrote the migration and tested it against a
                fixture of the previous schema. All twelve migration tests pass.
              </p>
            </div>
          </div>
        </div>
        <figcaption className={`${s.note} mt-12 border-t border-line pt-4`}>
          Diagram · the first two generations are the run in the capture below; the third shows the limit
        </figcaption>
      </figure>

      {claim?.capture ? (
        <div className={`${s.measure} mt-16 sm:mt-20`}>
          <Plate claim={claim} />
        </div>
      ) : null}
    </section>
  )
}

function Beat({ beat, className = "" }: { beat: Facet | undefined; className?: string }) {
  if (!beat) return null
  return (
    <div className={className}>
      <p className="text-[19px] leading-[1.3] font-[580] tracking-[-0.016em] text-ink">{beat.title}</p>
      <p className={`${s.body} mt-2 max-w-[40ch] text-[16px]`}>{beat.body}</p>
    </div>
  )
}

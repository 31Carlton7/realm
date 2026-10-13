"use client"

import { useState, type CSSProperties } from "react"

import type { Facet } from "@/content/home"
import { FACES } from "@/lib/mark"

import { Register } from "./kinetic"
import s from "./paper.module.css"

type Point = readonly [number, number]

/** The cube's three axes as the mark draws them: up-left (the top's normal), down-left (the left
 *  wall's) and right (the right wall's, the doorway's depth). */
const UP: Point = [-0.5, -0.8660254]
const DOWN: Point = [-0.5, 0.8660254]
const OUT: Point = [1, 0]

const add = (...ps: Point[]): Point => [ps.reduce((a, p) => a + p[0], 0), ps.reduce((a, p) => a + p[1], 0)]
const times = (p: Point, k: number): Point => [p[0] * k, p[1] * k]

/**
 * Where each face goes when the mark comes apart, in mark units: the walls straight off along their
 * own normals, and the doorway's three parts pulled out of the dark wall together and then a little
 * apart, each along the wall it is parallel to.
 */
const FLIGHT: Record<string, Point> = {
  top: times(UP, 8),
  left: times(DOWN, 8),
  right: times(OUT, 8),
  floor: add(times(OUT, 21), times(UP, 3.2)),
  jamb: add(times(OUT, 21), times(DOWN, 3.2)),
  lit: times(OUT, 27),
}

/** How much further a face lifts, along the same line, when its label is pointed at. */
const LIFT = 2.6

/** The paper tones the faces are printed in: the top lightest, the dark wall darkest, and the
 *  doorway's back — the agent — in the accent, lit. */
const FILL: Record<string, string> = {
  top: "oklch(0.995 0.002 264)",
  left: "oklch(0.925 0.005 264)",
  right: "oklch(0.83 0.008 264)",
  floor: "oklch(0.97 0.003 264)",
  jamb: "oklch(0.885 0.006 264)",
  lit: "oklch(0.86 0.075 256)",
}

/** The face's names as a drawing would letter them, beside what each one holds. */
const PART: Record<string, string> = {
  top: "Top",
  left: "Left wall",
  right: "Dark wall",
  floor: "Doorway floor",
  jamb: "Doorway jamb",
  lit: "Doorway back",
}

const centroid = (points: readonly Point[]): Point =>
  times(points.reduce<Point>((a, p) => add(a, p), [0, 0]), 1 / points.length)

/** Which way each label stands off from its face, and how far (mark units). */
const STANDOFF: Record<string, Point> = {
  top: [-11, -13],
  left: [-11, 13],
  right: [9, -17],
  floor: [10, 12],
  jamb: [12, 2],
  lit: [9, -12],
}

/** Where each leader line meets its face (the face's middle, after its flight), and where its label is. */
const LABELS = Object.fromEntries(
  FACES.map((face) => {
    const tip = add(centroid(face.polygon), FLIGHT[face.name]!)
    return [face.name, { tip, at: add(tip, STANDOFF[face.name]!) }]
  }),
) as Record<string, { tip: Point; at: Point }>

/** The drawing's window onto the mark's units: room for the flight and the labels. */
const VIEW = { x: -14, y: -14, w: 98, h: 76 }
const pct = ([x, y]: Point) => ({ left: `${((x - VIEW.x) / VIEW.w) * 100}%`, top: `${((y - VIEW.y) / VIEW.h) * 100}%` })

const path = (points: readonly Point[]) => `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`

/**
 * What a space holds, as an exploded axonometric of the mark. The mark is a cube with a doorway in
 * its dark wall, and its six faces are the six things a space holds; as the section rises the faces
 * come apart along the cube's own axes, and each is labelled with what it is. Pointing at a label (or
 * focusing or tapping it) lifts its face and opens its caption, and pointing at a face does the same.
 */
export function Anatomy({ facets, coda }: { facets: Facet[]; coda: Facet }) {
  const [active, setActive] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const shown = active ?? pinned

  return (
    <section data-running-head="What a space holds" aria-labelledby="anatomy-title" className={`${s.section} ${s.anatomy}`}>
      <div className={`${s.measure} ${s.grid} gap-y-12`}>
        <div className="col-span-12 lg:col-span-5">
          <Register id="anatomy-title" text="What a space holds." className={`${s.statement} text-ink`} />
          <p className={`${s.lede} mt-7 max-w-[34rem]`}>
            Realm&rsquo;s mark is a cube with a doorway in its dark wall. Its six faces are the six things a space holds.
          </p>

          <ol className="mt-10 border-t border-line" onMouseLeave={() => setActive(null)}>
            {facets.map((facet, i) => {
              const open = shown === i
              return (
                <li key={facet.title} className="border-b border-line">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`facet-${i}`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    onClick={() => setPinned((p) => (p === i ? null : i))}
                    className="group flex w-full items-baseline gap-4 py-3.5 text-left"
                  >
                    <span className="w-28 shrink-0 text-[13px] text-ink-3">{PART[FACES[i]!.name]}</span>
                    <span
                      className={`text-[19px] leading-[1.3] font-[560] tracking-[-0.016em] transition-colors duration-200 ${open ? "text-ink" : "text-ink-2 group-hover:text-ink"}`}
                    >
                      {facet.title}
                    </span>
                  </button>
                  <div
                    id={`facet-${i}`}
                    className={`grid transition-[grid-template-rows] duration-500 ease-[var(--ease-out-strong)] motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
                  >
                    <p className={`${s.body} overflow-hidden text-[16px] sm:pl-32`}>
                      <span className="block pb-5">{facet.body}</span>
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        <figure className="col-span-12 lg:col-span-7 lg:pl-6">
          <div className="relative" style={{ aspectRatio: `${VIEW.w} / ${VIEW.h}` }}>
            <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
              {FACES.map((face, i) => {
                const [fx, fy] = FLIGHT[face.name]!
                const lifted = shown === i
                return (
                  <g
                    key={face.name}
                    className={s.explode}
                    style={{ "--fx": `${fx}px`, "--fy": `${fy}px` } as CSSProperties}
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onClick={() => setPinned((p) => (p === i ? null : i))}
                  >
                    <g
                      className={s.lift}
                      data-lifted={lifted ? "" : undefined}
                      style={{ "--lx": `${(fx / Math.hypot(fx, fy)) * LIFT}px`, "--ly": `${(fy / Math.hypot(fx, fy)) * LIFT}px` } as CSSProperties}
                    >
                      <path
                        d={path(face.polygon)}
                        fill={FILL[face.name]}
                        stroke={lifted ? "var(--color-accent-ink)" : "var(--color-ink)"}
                        strokeWidth={lifted ? 0.32 : 0.22}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                        className="transition-[stroke] duration-200"
                      />
                    </g>
                  </g>
                )
              })}
              {/* Leader lines, drawn from each label to its face's resting place after the flight. */}
              <g className={s.leaders}>
                {FACES.map((face, i) => {
                  const label = LABELS[face.name]!
                  return (
                    <line
                      key={face.name}
                      x1={label.at[0]}
                      y1={label.at[1]}
                      x2={label.tip[0]}
                      y2={label.tip[1]}
                      stroke={shown === i ? "var(--color-accent-ink)" : "var(--color-line-strong)"}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </g>
            </svg>
            {FACES.map((face, i) => (
              <span
                key={face.name}
                aria-hidden
                style={pct(LABELS[face.name]!.at)}
                className={`${s.leaderLabel} absolute hidden text-[14px] leading-[1.25] font-[520] tracking-[-0.01em] whitespace-nowrap transition-colors duration-200 md:block ${STANDOFF[face.name]![0] < 0 ? "-translate-x-full -translate-y-full pr-1.5 text-right" : "-translate-y-full pl-1.5"} ${shown === i ? "text-accent-ink" : "text-ink"}`}
              >
                {facets[i]?.title}
              </span>
            ))}
          </div>
          <figcaption className="mt-6 grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-8">
            <span className={s.caption}>
              <span className="text-ink">{coda.title}</span> {coda.body}
            </span>
            <span className={`${s.note} sm:text-right`}>Diagram · the mark, drawn apart</span>
          </figcaption>
        </figure>
      </div>
    </section>
  )
}

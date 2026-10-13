"use client"

import { useRef, useState, type ReactNode } from "react"

import { AgentMark, ToolMark } from "@/components/AgentMark"
import { Icon } from "@/components/home/mini/icons"

import { centre, useAnchors } from "../kit/anchors"
import { Instrument } from "../kit/Chapter"
import { useScrollProgress } from "../kit/hooks"
import { span } from "../kit/math"
import { route } from "../kit/route"
import { Signal, SignalDefs, useTrips } from "../kit/signal"

type Lane = "agent" | "realm" | "server" | "gh"
type Step = { from: Lane; to: Lane; label: ReactNode; key?: boolean; note?: string; gate?: boolean }
type Scenario = { id: "linear" | "github"; name: string; lanes: { id: Lane; name: string; sub: string; glyph: ReactNode }[]; steps: Step[] }

const RealmGlyph = () => (
  <svg viewBox="0 0 40 48" aria-hidden className="h-3.5 w-auto" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205ZM24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z"
    />
  </svg>
)

const Code = ({ children }: { children: ReactNode }) => <span className="font-mono text-[11.5px] text-ink">{children}</span>

/** Two sample calls. What they claim is the gateway's and code review's own behaviour, from the page's claims. */
const SCENARIOS: Scenario[] = [
  {
    id: "linear",
    name: "A connection",
    lanes: [
      { id: "agent", name: "The agent", sub: "in a session", glyph: <AgentMark id="claude" className="size-3.5" /> },
      { id: "realm", name: "Realm", sub: "the space's gateway", glyph: <RealmGlyph /> },
      { id: "server", name: "Linear", sub: "its MCP server", glyph: <ToolMark id="linear" className="size-3.5" /> },
    ],
    steps: [
      { from: "agent", to: "realm", label: <Code>list_issues(assignee: me)</Code>, note: "The agent calls the tool, on Realm's one endpoint." },
      { from: "realm", to: "server", label: <Code>list_issues</Code>, key: true, note: "Realm calls the server, with the token." },
      { from: "server", to: "realm", label: <span>12 issues</span> },
      { from: "realm", to: "agent", label: <span>12 issues</span>, note: "The agent gets the result. Never the token." },
    ],
  },
  {
    id: "github",
    name: "Code review",
    lanes: [
      { id: "agent", name: "The reviewer", sub: "read-only", glyph: <AgentMark id="claude" className="size-3.5" /> },
      { id: "realm", name: "Realm", sub: "Code review", glyph: <RealmGlyph /> },
      { id: "gh", name: "Your gh", sub: "its own login", glyph: <Icon name="terminal" className="size-3.5" /> },
      { id: "server", name: "GitHub", sub: "the pull request", glyph: <ToolMark id="github" className="size-3.5" /> },
    ],
    steps: [
      { from: "realm", to: "gh", label: <Code>gh pr view 42</Code>, note: "Realm sees exactly what your gh sees, and holds no GitHub token." },
      { from: "gh", to: "server", label: <span>its own login</span>, key: true },
      { from: "realm", to: "agent", label: <span>the diff</span>, note: "The reviewer reads it on the model you pick." },
      { from: "agent", to: "realm", label: <span>3 findings</span>, note: "They stay on the page in Realm." },
      { from: "realm", to: "server", label: <span>your review</span>, gate: true, note: "Nothing reaches GitHub until you press Submit review." },
    ],
  },
]

const ROW = 64
const HEAD = 86

export function Gateway() {
  const [which, setWhich] = useState<Scenario["id"]>("linear")
  const [submitted, setSubmitted] = useState(false)
  const scenario = SCENARIOS.find((s) => s.id === which)!
  const drawing = useRef<HTMLDivElement>(null)
  const anchors = useAnchors(drawing, [which])
  const progress = useScrollProgress(drawing, { from: 0.85, to: 0.3 })
  const replay = useTrips<"run">()
  const sent = useTrips<"gate">()
  const [log, setLog] = useState(1)

  const steps = scenario.steps
  const x = (lane: Lane) => {
    const a = anchors.at[`lane-${lane}`]
    return a ? centre(a)[0] : 0
  }
  const y = (i: number) => HEAD + 34 + i * ROW
  const height = HEAD + 34 + steps.length * ROW + 10

  // Scroll draws the call step by step the first time through; Call again replays it in time.
  const run = replay.trips[0]
  // The steps scroll draws, and a gate the reader opens: until Submit review, the review's last
  // arrow is drawn dashed and waits; pressing it sends that arrow on its own.
  const t = run && replay.started(run) ? replay.progress(run) : progress
  const flowing = steps.filter((st) => !st.gate)
  const per = 1 / flowing.length
  const shownSteps = flowing.filter((_, i) => t >= i * per + per * 0.15).length
  const activeIndex = Math.min(flowing.length - 1, Math.floor(t / per))
  const gate = steps.findIndex((st) => st.gate)
  const gateTrip = sent.trips[0]
  const gateK = gateTrip && sent.started(gateTrip) ? sent.progress(gateTrip) : submitted ? 1 : 0
  const shown = (i: number) => (steps[i]!.gate ? shownSteps >= flowing.length : i < shownSteps)

  const submit = () => {
    setSubmitted(true)
    sent.clear()
    sent.fire("gate", 900)
  }

  const again = () => {
    replay.clear()
    replay.fire("run", 2600)
    setLog((n) => n + 1)
  }

  return (
    <Instrument
      kind="Diagram"
      caption={which === "linear" ? "One tool call, as a sequence. Scroll through it, or make it again." : "A review, as a sequence. Nothing goes out until you submit it."}
      controls={
        <div role="group" aria-label="Which call" className="inline-flex gap-1 rounded-[12px] bg-canvas p-1">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={which === s.id}
              onClick={() => {
                setWhich(s.id)
                setSubmitted(false)
                replay.clear()
              }}
              className="app-corner h-8 rounded-[8px] px-3 text-[13px] text-ink-2 transition-colors hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink"
            >
              {s.name}
            </button>
          ))}
        </div>
      }
    >
      {/* A phone has no room for lanes side by side, so the same call is a list of its steps. */}
      <ol className="space-y-3 sm:hidden">
        {steps.map((s, i) => {
          const lane = (id: Lane) => scenario.lanes.find((l) => l.id === id)!
          const pending = s.gate && !submitted
          return (
            <li key={i} className={`rounded-[12px] bg-canvas px-4 py-3 ${pending ? "opacity-70" : ""}`}>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink">
                <span className="text-ink-2">{lane(s.from).name}</span>
                <svg aria-hidden width="18" height="8" viewBox="0 0 18 8" fill="none">
                  <path d="M1 4h15M12 1l4 3-4 3" stroke="oklch(1 0 0 / 0.55)" />
                </svg>
                <span className="text-ink-2">{lane(s.to).name}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-ink-2">
                  {s.label}
                  {s.key ? (
                    <span className="inline-flex items-center gap-1 rounded-[6px] bg-[oklch(0.68_0.173_253.301/0.14)] px-1.5 py-0.5 text-[11.5px] text-accent-ink">
                      <KeyGlyph /> token
                    </span>
                  ) : null}
                </span>
              </p>
              {s.note ? <p className="mt-1.5 text-[12.5px] leading-[1.5] text-ink-2">{s.note}</p> : null}
              {pending ? (
                <button
                  type="button"
                  onClick={submit}
                  className="app-corner mt-2.5 rounded-[9px] bg-accent-fill px-3 py-1.5 text-[12.5px] text-white transition-[background-color,scale] hover:bg-accent-fill-hover active:scale-[0.97]"
                >
                  Submit review
                </button>
              ) : null}
            </li>
          )
        })}
        {scenario.id === "linear" ? <li className="px-1 text-[12.5px] text-accent-ink">The credential never reaches the agent.</li> : null}
      </ol>

      <div ref={drawing} className="relative hidden sm:block">
        <div className="relative" style={{ height }}>
          <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" fill="none">
            <SignalDefs id="gate" />
            {scenario.lanes.map((lane) => (
              <path key={lane.id} d={`M${x(lane.id)} ${HEAD}V${height}`} stroke="oklch(1 0 0 / 0.14)" strokeDasharray="2 4" />
            ))}
            {/* Where the credential stops: between the agent and Realm. */}
            {anchors.width ? (
              <g>
                <path
                  d={`M${x("realm") - 26} ${HEAD - 6}V${height}`}
                  stroke="oklch(0.788 0.113 248.33 / 0.45)"
                  strokeWidth={1}
                />
              </g>
            ) : null}
            {steps.map((s, i) => {
              if (!shown(i)) return null
              const a = x(s.from)
              const b = x(s.to)
              const yy = y(i)
              const dir = Math.sign(b - a)
              const r = route([[a + dir * 6, yy], [b - dir * 8, yy]])
              const waiting = s.gate && !submitted
              const active = s.gate ? gateK > 0 && gateK < 1 : i === activeIndex && t < 1
              const k = s.gate ? gateK : active ? (t - i * per) / per : 1
              return (
                <g key={i}>
                  <path d={r.d} stroke={waiting ? "oklch(1 0 0 / 0.25)" : "oklch(1 0 0 / 0.5)"} strokeDasharray={waiting ? "3 4" : undefined} />
                  <path d={`M${b - dir * 8} ${yy - 4}L${b - dir * 2} ${yy}L${b - dir * 8} ${yy + 4}`} stroke={waiting ? "oklch(1 0 0 / 0.3)" : "oklch(1 0 0 / 0.6)"} strokeLinejoin="round" />
                  {active && k > 0 && k < 1 ? <Signal defs="gate" route={r} s={r.length * span(k, 0.1, 0.9)} dir={dir > 0 ? 1 : -1} /> : null}
                </g>
              )
            })}
          </svg>

          {/* The lifelines' heads. */}
          <div className="absolute inset-x-0 top-0 grid" style={{ gridTemplateColumns: `repeat(${scenario.lanes.length}, minmax(0, 1fr))` }}>
            {scenario.lanes.map((lane) => (
              <div key={lane.id} className="flex justify-center">
                <div data-anchor={`lane-${lane.id}`} className="flex w-[9.5rem] flex-col items-center rounded-[12px] bg-canvas px-3 py-2.5 text-center">
                  <span className="flex items-center gap-1.5 text-[13px] text-ink">
                    <span className="text-ink-2">{lane.glyph}</span>
                    {lane.name}
                  </span>
                  <span className="text-[12px] text-ink-3">{lane.sub}</span>
                </div>
              </div>
            ))}
          </div>
          <p
            style={{ left: x("realm") - 34, top: height - 22 }}
            className="absolute -translate-x-full text-[12px] whitespace-nowrap text-accent-ink"
          >
            The credential never crosses this line
          </p>

          {/* What each arrow carries. */}
          {steps.map((s, i) => {
            const a = x(s.from)
            const b = x(s.to)
            const hidden = !shown(i)
            return (
              <div key={i} style={{ top: y(i) - 26, left: Math.min(a, b), width: Math.abs(b - a) }} className={`absolute flex flex-col items-center transition-opacity duration-300 ${hidden ? "opacity-0" : "opacity-100"}`}>
                <span className="flex items-center gap-1.5 bg-page px-1.5 text-[12.5px] whitespace-nowrap text-ink-2">
                  {s.label}
                  {s.key ? (
                    <span title="The token" className="inline-flex items-center gap-1 rounded-[6px] bg-[oklch(0.68_0.173_253.301/0.14)] px-1.5 py-0.5 text-[11.5px] text-accent-ink">
                      <KeyGlyph /> token
                    </span>
                  ) : null}
                </span>
                {s.gate && !submitted ? (
                  <button
                    type="button"
                    onClick={submit}
                    className="app-corner absolute top-[32px] rounded-[9px] bg-accent-fill px-3 py-1.5 text-[12.5px] whitespace-nowrap text-white transition-[background-color,scale] hover:bg-accent-fill-hover active:scale-[0.97]"
                  >
                    Submit review
                  </button>
                ) : s.note ? (
                  <span className="absolute top-[34px] bg-page px-1.5 text-[12px] whitespace-nowrap text-ink-2">{s.note}</span>
                ) : null}
              </div>
            )
          })}

        </div>
      </div>

      {scenario.id === "linear" ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[12px] text-ink-3">
            Realm&rsquo;s log · {log} {log === 1 ? "call" : "calls"} · each with its arguments and what came back
          </p>
          <button
            type="button"
            onClick={again}
            className="app-corner rounded-[9px] bg-canvas px-3 py-1.5 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-raised hover:text-ink"
          >
            Call it again
          </button>
        </div>
      ) : null}
    </Instrument>
  )
}

function KeyGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
      <circle cx="5.5" cy="8" r="2.75" />
      <path d="M8.25 8h5.25M11.5 8v2M13.5 8v1.5" />
    </svg>
  )
}

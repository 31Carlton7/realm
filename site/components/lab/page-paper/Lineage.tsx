import type { ReactNode } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"
import type { Claim, Facet } from "@/content/home"

import { Register } from "./kinetic"
import s from "./paper.module.css"
import { Plate } from "./Plates"

/** One person in the family: a name, what it was asked, and where it stands. */
function Member({
  agent,
  name,
  by,
  children,
  state,
  tone = "ink",
}: {
  agent?: AgentId
  name: string
  by?: string
  children?: ReactNode
  state?: ReactNode
  tone?: "ink" | "muted"
}) {
  return (
    <div className={`${s.member} min-w-0`}>
      <p className={`flex items-baseline gap-2 text-[18px] leading-[1.3] font-[580] tracking-[-0.018em] ${tone === "ink" ? "text-ink" : "text-ink-2"}`}>
        {agent ? <AgentMark id={agent} className="h-[0.8em] w-[0.8em] shrink-0 translate-y-[0.06em] text-ink-2" /> : null}
        <span>{name}</span>
        {by ? <span className="text-[14px] font-[450] tracking-normal text-ink-3">{by}</span> : null}
      </p>
      {children ? <p className="mt-1.5 max-w-[34ch] text-[15px] leading-[1.5] text-ink-2">{children}</p> : null}
      {state ? <p className={`${s.note} mt-2`}>{state}</p> : null}
    </div>
  )
}

/** A rule of the tree: down from a parent, or across to its children. Drawn as the reader reaches it. */
function Drop({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`${s.drop} block w-px bg-ink/45 ${className}`} />
}

/**
 * The delegation, as a family tree that grows as it is read. The first two levels are the run in the
 * delegation capture under it (the same models, tasks and states); the third level shows the limit,
 * which the capture does not reach. The four sentences beside it are the delegation's own account,
 * each set level with the generation it describes.
 */
export function Lineage({ claim, beats }: { claim: Claim | undefined; beats: Facet[] }) {
  const [start, several, deep, back] = beats
  return (
    <section data-running-head="Agents handing work on" aria-labelledby="lineage-title" className={s.section}>
      <div className={`${s.measure} ${s.grid} gap-y-6`}>
        <div className="col-span-12 lg:col-span-7">
          <Register id="lineage-title" text={claim?.title ?? "Hand work to other models."} className={`${s.statement} text-ink`} />
        </div>
        <p className={`${s.body} col-span-12 max-w-[60ch] lg:col-span-5 lg:pt-3`}>{claim?.body}</p>
      </div>

      <figure className={`${s.measure} mt-16 sm:mt-24`} aria-label="Diagram: a session handing work to two sub-agents, one of which hands work on once more">
        <div className={`${s.grid} gap-y-0`}>
          {/* Level one: you, and the session you asked. */}
          <Beat beat={start} />
          <div className={`${s.treeCell} col-span-12 lg:col-span-8 lg:col-start-5`}>
            <Member name="You">Add a dark-mode switch to the app settings, and keep the choice across launches.</Member>
            <Drop className="ml-3 h-10" />
            <Member agent="claude" name="Claude Opus 5.5" by="this session">
              Splits the work: the toggle and its tests go to GPT-6 Luna, and the migration to Fable.
            </Member>
            <Drop className="ml-3 h-10" />
          </div>

          {/* Level two: two sub-agents at once, on two harnesses. */}
          <Beat beat={several} />
          <div className={`${s.treeCell} col-span-12 lg:col-span-8 lg:col-start-5`}>
            <div className="relative grid gap-x-8 gap-y-10 sm:grid-cols-2">
              <span aria-hidden className={`${s.span} absolute top-0 left-3 hidden h-px bg-ink/45 sm:block sm:right-[calc(50%-1rem-0.75rem)]`} />
              <div className="relative sm:pt-8">
                <Drop className="absolute top-0 left-3 hidden h-8 sm:block" />
                <Member agent="openai" name="GPT-6 Luna" by="Codex" state={<><span className="text-orange">Needs you</span> · Allow Bash?</>}>
                  The toggle in Settings ▸ App, and its tests.
                </Member>
              </div>
              <div className="relative sm:pt-8">
                <Drop className="absolute top-0 left-3 hidden h-8 sm:block" />
                <Member agent="claude" name="Claude Fable 5.1" by="Claude" state={<><span className="text-green">Done</span> · twelve migration tests pass</>}>
                  Storing the choice, with a migration.
                </Member>
                <Drop className="mt-4 ml-3 h-10" />
              </div>
            </div>
          </div>

          {/* Level three: one more hand-off, and the end of the line. */}
          <Beat beat={deep} />
          <div className={`${s.treeCell} col-span-12 lg:col-span-8 lg:col-start-5`}>
            <div className="sm:ml-[calc(50%+1rem)]">
              <Member name="A sub-agent of its own" tone="muted">A sub-agent can hand work off once more.</Member>
              <Drop className="ml-3 h-8" />
              <p className="flex items-baseline gap-3 text-[15px] text-ink-2">
                <span aria-hidden className="relative -ml-px inline-block h-3 w-[25px] shrink-0">
                  <span className="absolute top-1/2 left-1/2 h-px w-3 -translate-x-1/2 rotate-45 bg-red" />
                  <span className="absolute top-1/2 left-1/2 h-px w-3 -translate-x-1/2 -rotate-45 bg-red" />
                </span>
                Past that, Realm says no.
              </p>
            </div>
          </div>

          {/* What comes back up the tree. */}
          <Beat beat={back} />
          <div className={`${s.treeCell} col-span-12 flex items-start gap-4 lg:col-span-8 lg:col-start-5`}>
            <span aria-hidden className={`${s.returnLine} mt-1 block h-24 w-px bg-accent-ink`} />
            <p className={`${s.note} max-w-[44ch]`}>
              Final report from Claude Fable 5.1: wrote the migration and tested it against a fixture of the previous
              schema. All twelve migration tests pass.
            </p>
          </div>
        </div>
        <figcaption className={`${s.note} mt-10 border-t border-line pt-4`}>
          Diagram · the first two levels are the run in the capture below; the third shows the limit
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

function Beat({ beat }: { beat: Facet | undefined }) {
  if (!beat) return null
  return (
    <div className="col-span-12 pt-10 pb-4 lg:col-span-4 lg:pt-0 lg:pb-14">
      <p className="text-[19px] leading-[1.3] font-[580] tracking-[-0.016em] text-ink">{beat.title}</p>
      <p className={`${s.body} mt-2 max-w-[40ch] text-[16px]`}>{beat.body}</p>
    </div>
  )
}

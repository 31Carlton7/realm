import { Fragment } from "react"

import { AgentMark, type AgentId } from "@/components/AgentMark"
import type { Claim } from "@/content/home"

import { Ink, Register } from "./kinetic"
import s from "./paper.module.css"
import { Plate } from "./Plates"

const AGENTS: { id: AgentId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "openai", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini", name: "Gemini" },
  { id: "opencode", name: "OpenCode" },
  { id: "githubCopilot", name: "GitHub Copilot" },
  { id: "goose", name: "goose" },
  { id: "qwen", name: "Qwen Code" },
  { id: "grok", name: "Grok" },
]

/**
 * The agents Realm runs, set as a roll: nine names in one sentence, each with its maker's mark, inking
 * in one after another as the sentence rises. The claim and its plate follow: the model picker,
 * where every installed agent's models are one list.
 */
export function Agents({ claim }: { claim: Claim | undefined }) {
  return (
    <section data-running-head="The agents" aria-labelledby="agents-title" className={s.section}>
      <div className={`${s.measure} ${s.grid} gap-y-8`}>
        <p className={`${s.note} col-span-12 lg:col-span-3 lg:pt-3`}>
          Most of them through one Agent Client Protocol adapter
        </p>
        <div className="col-span-12 lg:col-span-9">
          <Register id="agents-title" text="Bring the agent you already use." className={`${s.statement} text-ink`} />
          <p
            className={`${s.inkScope} mt-10 text-[clamp(1.75rem,3.3vw,3.25rem)] leading-[1.14] tracking-[-0.03em] text-pretty text-ink sm:mt-14`}
            style={{ ["--set-weight" as string]: 600, ["--set-tracking" as string]: "-0.035em", ["--step" as string]: "2.4%" }}
          >
            {AGENTS.map((agent, i) => (
              <Fragment key={agent.id}>
                <span className="whitespace-nowrap">
                  <AgentMark id={agent.id} className="mr-[0.22em] inline-block h-[0.68em] w-[0.68em] -translate-y-[0.06em] text-ink-2" />
                  <Ink index={i}>{agent.name}</Ink>
                </span>
                {i < AGENTS.length - 2 ? ", " : i === AGENTS.length - 2 ? " and " : null}
              </Fragment>
            ))}{" "}
            <span className="text-ink-2">all run here.</span>
          </p>
          <div className="mt-12 grid gap-8 md:grid-cols-2 md:gap-10">
            <p className={s.body}>
              Each keeps its own login, models and permission modes. The model picker groups models by the harness that
              runs them, and its footer holds each model&rsquo;s effort levels and fast mode.
            </p>
            <p className={s.body}>
              <span className="text-ink">Realm never asks for an API key.</span> Signing in runs the agent&rsquo;s own
              login, and you&rsquo;re the one who approves it.
            </p>
          </div>
        </div>
      </div>
      {claim?.capture ? (
        <div className={`${s.measure} mt-16 sm:mt-20`}>
          <div className={s.grid}>
            <div className="col-span-12 lg:col-span-9 lg:col-start-4">
              <Plate claim={claim} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

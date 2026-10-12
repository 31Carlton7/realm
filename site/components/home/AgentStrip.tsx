import type { CSSProperties } from "react"

import { AgentMark, markColor, type AgentId } from "@/components/AgentMark"

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
 * The agents Realm runs, where Clerk keeps its wall of customers: one row of flat marks in a hairline
 * grid whose rules run past its ends and fade. Still, because design.md refuses a marquee; a mark
 * takes its maker's colour under the pointer where it has one, and stays ink where it does not.
 */
export function AgentStrip() {
  return (
    <section aria-labelledby="agents-title" className="relative mx-auto w-full max-w-[92rem] px-6 pt-4 pb-20 sm:px-10 sm:pb-28">
      <h2 id="agents-title" className="mx-auto max-w-[44ch] text-center text-[15px] leading-[1.55] text-ink-2">
        Runs the agents you already have, each with its own login, models and permission modes.{" "}
        <span className="text-ink">Realm never asks for an API key.</span>
      </h2>

      <div className="relative mt-9">
        {/* The rules above and below run the page's width and fade at both ends. */}
        <div aria-hidden className="strip-rule absolute inset-x-0 top-0" />
        <div aria-hidden className="strip-rule absolute inset-x-0 bottom-0" />
        <ul className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9">
          {AGENTS.map(({ id, name }) => (
            <li
              key={id}
              style={{ "--brand": markColor(id) ?? "var(--color-ink)" } as CSSProperties}
              className="group flex flex-col items-center gap-3 border-line px-2 py-7 text-ink-2 max-lg:border-b sm:py-8 lg:border-l lg:last:border-r"
            >
              <span className="text-ink-2 transition-colors duration-200 group-hover:text-[var(--brand)]">
                <AgentMark id={id} className="h-6 w-6" />
              </span>
              <span className="text-[13px] transition-colors duration-200 group-hover:text-ink">{name}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

"use client"

import type { CSSProperties } from "react"

import { AgentMark, markColor } from "@/components/AgentMark"
import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"
import { LabCanvas } from "@/components/lab/LabCanvas"
import { AGENTS, COLUMN_HALF_REM, type StreamAgent } from "@/components/lab/streams/agents"
import { dimStream, lightStream } from "@/components/lab/streams/hot"
import { createStreams } from "@/components/lab/streams/stage"
import { StreamsFallback } from "@/components/lab/streams/StreamsFallback"

/**
 * Streams: bring the coding agent you already use. Every agent Realm runs sits beside the words as
 * its own mark, and a hairline of light runs from each into the one workspace below.
 */
export default function Streams({ download }: ConceptProps) {
  return (
    <section data-lab-anchor="stage" className="relative pb-24 sm:pb-32">
      <LabCanvas create={createStreams} />
      <StreamsFallback />
      <div className="relative mx-auto w-full max-w-[82rem] px-4 pt-12 sm:px-10 sm:pt-16 lg:pt-10">
        {/* Each block of words is its own anchor, shrunk to what it holds, so the light keeps out of
            the words themselves rather than out of the whole column around them. */}
        <div data-lab-anchor="copy" className="mx-auto max-w-[48rem] lg:text-center">
          <div data-lab-anchor="copy-ann" className="lg:mx-auto lg:w-fit">
            <Announcement />
          </div>
          <div data-lab-anchor="copy-head" className="mt-7 lg:mt-6">
            <Headline className="lg:mx-auto lg:!text-[clamp(4rem,6.1vw,5.5rem)]" />
          </div>
          <div data-lab-anchor="copy-lede" className="mt-6 lg:mx-auto lg:mt-5 lg:max-w-[40rem]">
            <Lede />
          </div>
          <div data-lab-anchor="copy-act" className="mt-8 lg:mx-auto lg:mt-7 lg:w-fit">
            <Actions download={download} className="lg:[&>div]:justify-center lg:[&>p]:text-center" />
          </div>
        </div>
        <div className="relative mt-14 lg:mt-[6.5rem]">
          <ul aria-label="The agents Realm runs" className="mb-12 flex items-start justify-between lg:absolute lg:inset-x-0 lg:top-0 lg:mb-0 lg:block lg:h-0">
            {AGENTS.map((agent, i) => (
              <Mark key={agent.id} agent={agent} index={i} />
            ))}
          </ul>
          <ProductWindow
            tab={false}
            frameClassName="h-[620px] sm:h-[640px] lg:h-[min(680px,calc(100dvh-7rem))] lg:min-h-[560px] [html[data-lab-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.16),0_-10px_40px_-18px_oklch(0.788_0.113_248.33/0.45)]"
          />
        </div>
      </div>
    </section>
  )
}

function Mark({ agent, index }: { agent: StreamAgent; index: number }) {
  const sign = agent.side === "left" ? "-" : "+"
  // On a phone the nine sit in one row that bows gently up toward its middle.
  const fromMiddle = (index - (AGENTS.length - 1) / 2) / ((AGENTS.length - 1) / 2)
  const style = {
    left: `calc(50% ${sign} ${COLUMN_HALF_REM}rem ${sign} ${agent.dx}px)`,
    top: `${-agent.dy}px`,
    "--brand": markColor(agent.id) ?? "var(--color-ink)",
    "--bow": `${Math.round(fromMiddle * fromMiddle * 10)}px`,
  } as CSSProperties
  return (
    <li style={style} className="max-lg:translate-y-[var(--bow)] lg:absolute lg:-translate-x-1/2 lg:-translate-y-1/2">
      <span
        tabIndex={0}
        data-lab-anchor={`mark-${agent.id}`}
        onPointerEnter={() => lightStream(index)}
        onPointerLeave={() => dimStream(index)}
        onFocus={() => lightStream(index)}
        onBlur={() => dimStream(index)}
        className="group relative grid size-8 place-items-center rounded-full bg-page text-ink-3 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[color,box-shadow] duration-200 hover:text-[var(--brand)] hover:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.2)] focus-visible:text-[var(--brand)] lg:size-10"
      >
        <AgentMark id={agent.id} className="size-4 lg:size-5" />
        <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap text-[12.5px] text-ink-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
          {agent.name}
        </span>
      </span>
    </li>
  )
}

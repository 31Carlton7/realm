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
        <div className="relative mt-14 xl:mt-[4.5rem]">
          {/* On a wide screen the marks are measured from the window's top edge, under the tab. */}
          <ul
            aria-label="The agents Realm runs"
            className="mx-auto mb-12 flex max-w-[40rem] items-start justify-between xl:absolute xl:inset-x-0 xl:top-8 xl:mb-0 xl:block xl:h-0 xl:max-w-none"
          >
            {AGENTS.map((agent, i) => (
              <Mark key={agent.id} agent={agent} index={i} />
            ))}
          </ul>
          {/* The window's own caption, moved from its corner to the middle of its top edge: the streams
              land at both shoulders, and what they bring runs along the frame toward it. Both ends are
              cut at the 60 degrees the corner tab cuts its far end at. */}
          <p
            style={{ clipPath: "polygon(18.5px 0, calc(100% - 18.5px) 0, 100% 100%, 0 100%)" }}
            className="relative z-10 mx-auto hidden h-8 w-fit items-center gap-2 bg-surface px-8 text-[12.5px] text-ink-2 xl:flex"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green" />
            A working sample of Realm. Click anything.
          </p>
          <ProductWindow
            tab={false}
            frameClassName="h-[620px] sm:h-[640px] lg:h-[min(680px,calc(100dvh-7rem))] lg:min-h-[560px] [html[data-lab-field=off]_&]:shadow-[0_0_0_1px_oklch(1_0_0/0.16),0_-10px_40px_-18px_oklch(0.788_0.113_248.33/0.45)]"
          />
          {/* Narrower, the streams land all along the window's top, so its caption goes under it. */}
          <p className="mt-4 flex items-center justify-center gap-2 text-[12.5px] text-ink-2 xl:hidden">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-green" />
            A working sample of Realm. Click anything.
          </p>
        </div>
      </div>
    </section>
  )
}

function Mark({ agent, index }: { agent: StreamAgent; index: number }) {
  const sign = agent.side === "left" ? "-" : "+"
  // On a phone the nine sit in one row that bows gently up toward its middle.
  const fromMiddle = (index - (AGENTS.length - 1) / 2) / ((AGENTS.length - 1) / 2)
  // Where it sits on its arc; `left` and `top` only take effect once the item is positioned, at xl.
  const style = {
    left: `calc(50% ${sign} ${COLUMN_HALF_REM}rem ${sign} ${agent.dx}px)`,
    top: `${-agent.dy}px`,
    "--brand": markColor(agent.id) ?? "var(--color-ink)",
    "--bow": `${Math.round(fromMiddle * fromMiddle * 10)}px`,
  } as CSSProperties
  return (
    <li style={style} className="max-xl:translate-y-[var(--bow)] xl:absolute xl:-translate-x-1/2 xl:-translate-y-1/2">
      <span
        tabIndex={0}
        data-lab-anchor={`mark-${agent.id}`}
        onPointerEnter={() => lightStream(index)}
        onPointerLeave={() => dimStream(index)}
        onFocus={() => lightStream(index)}
        onBlur={() => dimStream(index)}
        className="group relative grid size-8 place-items-center rounded-full bg-page text-ink-3 shadow-[inset_0_1px_0_oklch(1_0_0/0.05),inset_0_0_0_1px_oklch(1_0_0/0.105)] transition-[color,box-shadow] duration-200 hover:text-[var(--brand)] hover:shadow-[inset_0_1px_0_oklch(1_0_0/0.08),inset_0_0_0_1px_oklch(1_0_0/0.2)] focus:text-[var(--brand)] sm:size-10"
      >
        <AgentMark id={agent.id} className="size-4 sm:size-5" />
        <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap text-[12.5px] text-ink-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus:opacity-100">
          {agent.name}
        </span>
      </span>
    </li>
  )
}

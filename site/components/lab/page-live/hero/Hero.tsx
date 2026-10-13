"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { GitHubIcon } from "@/components/icons"
import { Announcement } from "@/components/lab/HeroParts"
import type { MacDownload } from "@/lib/release"
import { site } from "@/lib/site"

import { Sample } from "../sample/Sample"
import { createSampleStore, openingState, restingState, type SampleStore } from "../sample/store"
import { HeroLight } from "../field/HeroLight"
import { TransitMap } from "./TransitMap"

const reducedNow = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * The hero: the page's one sentence, and a live map of a workspace leading into the working sample of
 * the app it describes. The map is a diagram and says so; the window is a sample and says so. They
 * share one state, so a request the map shows arriving is the one the window's Needs you lists, and
 * answering it in the window is what the map shows coming back.
 */
export function Hero({ download }: { download: MacDownload }) {
  const [store] = useState<SampleStore>(() => createSampleStore(restingState()))
  const plateRef = useRef<HTMLDivElement>(null)
  const windowRef = useRef<HTMLDivElement>(null)
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)

  // A live hero opens just after Dark mode's lead has handed out its two tasks, and plays forward to
  // where nothing moves until the reader answers something. Reduced motion starts there.
  useEffect(() => {
    if (!reducedNow()) {
      store.reset(openingState(1))
      store.play()
    }
    return () => store.dispose()
  }, [store])

  const settled = Object.values(state.status).every((s) => s === "done" || s === "scheduled")
  const waiting = (["tests", "settings", "luna"] as const).filter((id) => state.status[id] === "waiting").length
  const replay = () => {
    store.reset(reducedNow() ? restingState(state.epoch + 1) : openingState(state.epoch + 1))
    if (!reducedNow()) store.play()
  }

  return (
    <section aria-labelledby="hero-title" className="relative">
      <div className="mx-auto w-full max-w-[85rem] px-5 pt-5 sm:px-10 sm:pt-8 lg:pt-9">
        <Announcement />
        <h1
          id="hero-title"
          className="mt-4 max-w-[14ch] text-[clamp(2.4rem,4.7vw,4.4rem)] leading-[0.98] font-[580] tracking-[-0.052em] text-balance text-ink sm:mt-5 xl:max-w-none"
        >
          Give your agents a world to work in.
        </h1>
        <div className="mt-5 grid gap-7 lg:mt-6 lg:grid-cols-[minmax(0,40rem)_auto] lg:items-end lg:justify-between">
          <p className="max-w-[62ch] text-[17px] leading-[1.55] text-ink-2">
            Bring the coding agent you already use. Each space holds a checkout, the agents working on it, and the
            terminals, browsers and documents they open. Every space sits in one sidebar on your Mac, and it&rsquo;s all
            still there tomorrow.
          </p>
          <div className="lg:text-right">
            <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
              <DownloadButton href={download.href} />
              <QuietButton href={site.repo} external>
                <GitHubIcon className="h-4 w-4" />
                Source
              </QuietButton>
            </div>
            <p className="mt-3 font-mono text-[12px] text-ink-3">
              {download.version ? `${download.version} · ` : ""}macOS on Apple silicon · in active development
            </p>
          </div>
        </div>
      </div>

      <div role="group" aria-labelledby="hero-map-title" className="mx-auto mt-8 w-full max-w-[85rem] px-3 sm:px-10 lg:mt-10">
        <p className="mb-4 px-2 text-[13px] leading-[1.5] text-ink-2 sm:px-0">
          <span id="hero-map-title" className="text-ink">
            A sample of a day in Realm.
          </span>{" "}
          The map is a diagram of the window <span className="lg:hidden">under</span>
          <span className="hidden lg:inline">beside</span> it, and the window is a working sample: click anything.
        </p>
        <div ref={plateRef} className="relative isolate lg:grid lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
          <HeroLight />
          {/* The map's own room: beside the window on a wide screen, with its key at the foot; above
              it on a phone, where the lines turn down into its top edge. */}
          <div className="h-[350px] lg:flex lg:h-auto lg:flex-col lg:justify-end lg:pb-1">
            <div className="hidden lg:block">
              <Legend settled={settled} waiting={waiting} onReplay={replay} />
            </div>
          </div>
          {/* The map comes before the window in the reading and tab order, as it does on the page:
              its stations open their sessions in the window. */}
          <TransitMap store={store} plateRef={plateRef} windowRef={windowRef} />
          <div
            ref={windowRef}
            className="app-corner relative h-[620px] w-full overflow-hidden rounded-[20px] bg-page shadow-[0_0_0_1px_oklch(1_0_0/0.1)] lg:h-[640px]"
          >
            <Sample store={store} />
          </div>
        </div>
        <div className="mt-4 px-2 lg:hidden">
          <Legend settled={settled} waiting={waiting} onReplay={replay} />
        </div>
      </div>
    </section>
  )
}

function Legend({ settled, waiting, onReplay }: { settled: boolean; waiting: number; onReplay: () => void }) {
  return (
    <div>
      {/* What the map is waiting for, said once, where the key is read. */}
      <p aria-live="polite" className="mb-3 min-h-[1.5em] text-[13px] text-ink-2">
        {waiting ? (
          <>
            <span className="text-orange">{waiting === 1 ? "One request waits" : `${waiting === 2 ? "Two" : "Three"} requests wait`} on you.</span>{" "}
            Answer {waiting === 1 ? "it" : "them"} in the window&rsquo;s Needs you.
          </>
        ) : settled ? (
          "Everything came back."
        ) : null}
      </p>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-2">
      <span className="flex items-center gap-1.5">
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="var(--color-green)" />
        </svg>
        Working
      </span>
      <span className="flex items-center gap-1.5">
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="var(--color-orange)" />
        </svg>
        Waiting on you
      </span>
      <span className="flex items-center gap-1.5">
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="oklch(1 0 0 / 0.35)" />
        </svg>
        Done
      </span>
      <span className="flex items-center gap-1.5">
        <svg aria-hidden width="18" height="12" viewBox="0 0 18 12" fill="none">
          <path d="M1 6h10" stroke="var(--color-accent-ink)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="13" cy="6" r="2.2" fill="oklch(0.93 0.04 250)" />
        </svg>
        Work handed over
      </span>
      {settled ? (
        <button type="button" onClick={onReplay} className="text-accent-ink underline decoration-accent-ink/40 underline-offset-[3px] hover:decoration-accent-ink">
          Play the day again
        </button>
      ) : null}
    </div>
    </div>
  )
}

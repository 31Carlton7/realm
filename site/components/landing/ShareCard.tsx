import early from "@/content/early.json"

import { Mark } from "./Mark"
import { Sky } from "./Sky"
import s from "./landing.module.css"

const SHOT_WIDTH = 880

/**
 * The hero at a share card's size: the mark and the headline centred on deep navy, over the same new
 * session the page opens with. The Sky keeps every star out from under the words it marks
 * `data-clear`, as it does on the page. Everything is centred, so a wider frame (GitHub's 1280 × 640)
 * re-lays rather than stretches.
 */
export function ShareCard() {
  const { w, h } = early.session
  return (
    <main className={`${s.page} relative flex h-[100dvh] flex-col items-center overflow-hidden`}>
      <Sky className={s.sky} />
      <p className="relative mt-[52px] inline-flex items-center gap-[12px] text-[28px] font-medium tracking-[-0.01em]" data-clear>
        <Mark className="h-[36px] w-auto" />
        <span>Realm</span>
      </p>
      <h1 className="relative mt-[30px] max-w-[14ch] text-center text-[64px] leading-none font-medium tracking-[-0.045em] text-balance" data-clear>
        One workspace for every coding agent.
      </h1>
      <img
        className="relative mt-[44px] rounded-[12px] shadow-[var(--lift)]"
        src="/early/session.webp"
        srcSet={`/early/session-1x.webp ${w}w, /early/session.webp ${w * 2}w`}
        sizes={`${SHOT_WIDTH}px`}
        width={SHOT_WIDTH}
        height={Math.round((SHOT_WIDTH * h) / w)}
        alt=""
      />
    </main>
  )
}

import { DownloadButton, QuietButton } from "@/components/Buttons"
import { GitHubIcon } from "@/components/icons"

/**
 * The page's one concrete next action, through a portal again, so it closes where it opened: the
 * field hands its corridor to this card once the hero's portal is off screen (`data-dim`).
 */
export function CloseCta({ href, version, repo }: { href: string; version: string | null; repo: string }) {
  return (
    <section aria-labelledby="close-title" className="mx-auto w-full max-w-[68rem] px-4 pt-24 pb-32 sm:px-10 sm:pt-36 sm:pb-44">
      <div
        data-dim="portal-close"
        className="app-corner relative overflow-hidden rounded-[28px] bg-surface px-6 py-16 text-center shadow-[inset_0_1px_0_oklch(1_0_0/0.08),inset_0_0_0_1px_var(--color-line)] sm:px-12 sm:py-24 [html[data-dim-field=off]_&]:shadow-[inset_0_1px_0_oklch(1_0_0/0.07),0_0_90px_-18px_oklch(0.68_0.173_253.301/0.5)]"
      >
        <img src="/realm-mark.svg" alt="" aria-hidden width={40} height={48} className="mx-auto h-16 w-auto" />
        <h2 id="close-title" className="mt-8 text-[clamp(2.2rem,5vw,4rem)] leading-[1] font-[580] tracking-[-0.05em] text-balance text-ink">
          Open your first realm.
        </h2>
        <p className="mx-auto mt-5 max-w-[46ch] text-[17px] leading-[1.55] text-ink-2">
          Point it at a checkout, start a session with an agent you already have, and leave the window open all
          day.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
          <DownloadButton href={href} size="lg" />
          <QuietButton href={repo} external>
            <GitHubIcon className="h-4 w-4" />
            Read the source
          </QuietButton>
        </div>
        <p className="mt-4 font-mono text-[12px] text-ink-3">{version ? `${version} · ` : ""}macOS on Apple silicon</p>
      </div>
    </section>
  )
}

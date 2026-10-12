import { describeLoadError, type BrowserLoadError } from "@realm/contracts";
import { useId, useRef } from "react";
import { REALM_MARK_ASPECT, REALM_MARK_PATH, REALM_MARK_VIEWBOX } from "../../components/RealmMark";
import { useDissolve } from "../../components/ScrollFades";
import { RunnerGame } from "./runner/RunnerGame";
import { offersRunner } from "./runner/runner";

/**
 * Realm's flat mark, in the accent: the pane reaching for a page. It is still when nothing is being
 * tried — the error page wears it at rest — and while a load is in flight it dims and a glint crosses
 * it, clipped to its shape so the glint goes through the doorway rather than over it: the boot mark's
 * sweep, at the same tempo, so Realm waits the same way everywhere. It fades up once as it arrives.
 * Under reduced motion it is simply drawn.
 */
export function ReachMark({ busy, size = 44 }: { busy: boolean; size?: number }) {
  // useId's own characters are not all safe inside url(#…).
  const id = `reach-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  return (
    <svg className="reach-mark" data-busy={busy || undefined} width={size} height={Math.round(size * REALM_MARK_ASPECT)}
      viewBox={REALM_MARK_VIEWBOX} aria-hidden="true">
      <defs>
        <clipPath id={`${id}-shape`}><path clipRule="evenodd" d={REALM_MARK_PATH} /></clipPath>
        <linearGradient id={`${id}-glint`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset=".5" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="reach-mark-shape" fillRule="evenodd" d={REALM_MARK_PATH} />
      <g clipPath={`url(#${id}-shape)`}>
        <rect className="reach-mark-glint" x="-24" y="0" width="24" height="48" fill={`url(#${id}-glint)`} />
      </g>
    </svg>
  );
}

/** An open padlock, drawn in a stroke: a connection Realm will not trust. */
function LockMark({ size = 44 }: { size?: number }) {
  return (
    <svg className="lock-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect x="11" y="22" width="26" height="19" rx="5" />
      <path d="M16.5 22v-6.5a7.5 7.5 0 0 1 14.2-3.4" />
      <path d="M24 29v5" />
    </svg>
  );
}

/**
 * A page that did not load, drawn where the page would be.
 *
 * DOM rather than a document loaded into the view, and the view is hidden while it shows. The view is
 * opaque — it has to be, pages assume a white canvas — so a page drawn inside it could never be the
 * pane's own translucent ground: it would be a slab of another colour under the toolbar. Here it is the
 * session pane's ground, in Realm's type and tokens, and it follows the theme, the light face and
 * Reduce motion like everything else in the window. Chromium has already committed the failed address
 * as an entry of its own, so the bar keeps it, Back and Forward walk past it, and Reload retries it.
 *
 * The copy is `describeLoadError`'s, which is also what an agent driving the pane is told.
 */
export function BrowserErrorPage({ error, busy, onReload }: { error: BrowserLoadError; busy: boolean; onReload: () => void }) {
  const page = describeLoadError(error);
  const titleId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  return (
    <div className="browser-error" ref={scroller} role="region" aria-labelledby={titleId} data-mark={page.mark}>
      <div className="browser-error-body">
        {page.mark === "lock" ? <LockMark /> : <ReachMark busy={busy} />}
        <h2 id={titleId} className="browser-error-title">{page.title}</h2>
        <p className="browser-error-reason">{page.reason}</p>
        {page.note && <p className="browser-error-reason">{page.note}</p>}
        {page.tips.length > 0 && (
          <div className="browser-error-try">
            <p>Try:</p>
            <ul>{page.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>
          </div>
        )}
        <p className="browser-error-code">{error.name}</p>
        {/* Busy while a load is in flight, not disabled: a retry that hangs on a dead host is one the
            person may want to start again, as every browser's error page lets them. */}
        <button type="button" className="btn primary browser-error-reload" aria-busy={busy || undefined} onClick={onReload}>Reload</button>
        {/* Something to do while a dev server comes up or the Wi-Fi comes back, under Reload. */}
        {offersRunner(error.name) && <RunnerGame seed={runnerSeed(error.url)} />}
      </div>
    </div>
  );
}

/** The same Realmite runs for the same host, so localhost:3000's runner is always the same one. */
function runnerSeed(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/**
 * The first page on its way, in a pane with nothing to show yet: the mark, quietly, and only once the
 * wait has gone on long enough to notice (the stylesheet holds it back) — a page that answers at once
 * never shows it. Decoration on top of the toolbar's Stop, which already says a load is in flight, so
 * it is hidden from assistive tech, and under reduced motion it goes rather than freezing.
 */
export function BrowserConnecting() {
  return (
    <div className="browser-connecting" aria-hidden="true">
      <ReachMark busy size={32} />
    </div>
  );
}

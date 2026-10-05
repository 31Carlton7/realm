import { describeLoadError, type BrowserLoadError } from "@realm/contracts";
import { useId, useRef } from "react";
import { useDissolve } from "../../components/ScrollFades";

/**
 * Realm's hexagon wound in on itself: a spiral of six-sided turns that ends in a flat stroke, the way
 * the mark's own bands do. It is the pane reaching for a page, so it is still when nothing is being
 * tried — the error page wears it at rest — and while a load is in flight a pulse runs out along it
 * from the middle. Drawn in once as it arrives. Under reduced motion it is simply drawn.
 */
const SPIRAL = "M18.99 20.48 L18.31 19.31 L20.07 16.26 L25.76 16.26 L29.69 23.06 L24.68 31.74 L12.49 31.74 L5.31 19.31 L13.57 5 L32.26 5 L42.69 23.06 L31.18 43 L5.99 43";

export function ReachMark({ busy, size = 44 }: { busy: boolean; size?: number }) {
  return (
    <svg className="reach-mark" data-busy={busy || undefined} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path className="reach-mark-line" d={SPIRAL} pathLength={100} />
      <path className="reach-mark-pulse" d={SPIRAL} pathLength={100} />
    </svg>
  );
}

/** An open padlock, in the spiral's hand: a connection Realm will not trust. */
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
      </div>
    </div>
  );
}

/**
 * The first page on its way, in a pane with nothing to show yet: the spiral, quietly, and only once the
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

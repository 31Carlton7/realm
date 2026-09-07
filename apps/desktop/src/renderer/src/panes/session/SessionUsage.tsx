import { useId, useState } from "react";
import type { Usage } from "./transcript-model";

/** Where the ring stops being ordinary. Two steps, not a gradient: the reader is being told "you have
 *  room", "start thinking about it", "this turn may not fit", and a hue that drifts continuously says
 *  none of those. */
const WARN_AT = 0.75;
const DANGER_AT = 0.9;

const toneFor = (fraction: number): "ok" | "warning" | "danger" =>
  fraction >= DANGER_AT ? "danger" : fraction >= WARN_AT ? "warning" : "ok";

/** Ring geometry. A 14px box with a 2px stroke reads at the under-strip's 11px scale without
 *  becoming a second focal point beside the model chip. */
const BOX = 14, STROKE = 2, R = (BOX - STROKE) / 2, C = 2 * Math.PI * R;

/** Compact token count: 1.2k, 184k, 1.05M. Thousands are what a context window is quoted in, so a
 *  bare 184320 would be a number the reader has to parse rather than read. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const formatCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/**
 * What fraction of the model's context window the last prompt filled, or null when that cannot be
 * stated.
 *
 * Both halves have to be real. `contextTokens` is emitted only by an adapter that knows its turn's
 * prompt size, and `window` comes from the model catalog, which has no row for a great many models —
 * so the honest answer is frequently "no meter", and that is what null means. Clamped at 1 rather
 * than allowed past it: a prompt that overran the catalog's figure says the catalog is stale, not
 * that the reader has used 118% of something.
 */
export function contextFraction(usage: Usage, window: number | null): number | null {
  if (usage.contextTokens === undefined || window === null || window <= 0) return null;
  return Math.min(1, Math.max(0, usage.contextTokens / window));
}

/**
 * The under-strip's session meter: a ring showing how full the context window is, with the rest of
 * the session's numbers one hover (or one Tab) away.
 *
 * It is the ring alone at rest because the numbers are not what the reader is watching for — the
 * question a running session asks all day is "have I got room", and that is a shape, not a figure.
 * Everything the ring compresses is still reachable, and reachable the same way from the keyboard as
 * from the pointer: the panel opens on focus as well as hover, and the control's accessible name
 * carries the percentage on its own so a screen reader never has to open anything to learn it.
 *
 * Draws NOTHING when the fraction cannot be computed. Nine of the eleven engines report no tokens at
 * all (USAGE_REPORTING), and a ring stuck at empty in every Cursor session would be a claim about
 * that session rather than an admission that Realm cannot see it.
 */
export function SessionUsage({ usage, contextWindow }: {
  usage: Usage;
  /** The active model's context window in tokens, or null when the catalog has no row for it. */
  contextWindow: number | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const fraction = contextFraction(usage, contextWindow);
  if (fraction === null) return null;
  const pct = Math.round(fraction * 100);
  const used = usage.contextTokens ?? 0;
  return (
    <div className="session-usage" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {/* A button, not a bare span: it is the panel's trigger for the keyboard as much as for the
          pointer, and `aria-describedby` only means something on a focusable element. */}
      <button type="button" className="session-usage-btn" data-tone={toneFor(fraction)}
        aria-label={`Context: ${pct}% of ${formatTokens(contextWindow!)} used`}
        aria-expanded={open} aria-controls={panelId}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}>
        <svg width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true" className="usage-ring">
          <circle className="usage-ring-track" cx={BOX / 2} cy={BOX / 2} r={R} fill="none" strokeWidth={STROKE} />
          {/* Rotated so the arc starts at twelve o'clock and runs clockwise — the direction every
              other filling ring in the world runs, and the one the reader predicts. */}
          <circle className="usage-ring-fill" cx={BOX / 2} cy={BOX / 2} r={R} fill="none" strokeWidth={STROKE}
            strokeDasharray={`${C * fraction} ${C}`} strokeLinecap="round"
            transform={`rotate(-90 ${BOX / 2} ${BOX / 2})`} />
        </svg>
        <span className="usage-pct">{pct}%</span>
      </button>
      {open && (
        <div id={panelId} className="session-usage-panel" role="presentation">
          <UsageRow label="Context" value={`${formatTokens(used)} / ${formatTokens(contextWindow!)}`} />
          {/* Cost only once there is spend to report. A `$0.000` under a Codex session would be a
              claim about money, and `costUsd: 0` there means "not reported", not "free". */}
          {usage.costUsd > 0 && <UsageRow label="Cost" value={formatCost(usage.costUsd)} />}
          <UsageRow label="Output" value={formatTokens(usage.outputTokens)} />
          <UsageRow label="Turns" value={String(usage.numTurns)} />
        </div>
      )}
    </div>
  );
}

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="session-usage-row">
      <span className="session-usage-label">{label}</span>
      <span className="session-usage-value">{value}</span>
    </div>
  );
}

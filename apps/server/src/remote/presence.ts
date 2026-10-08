/** How long a report stays believable. Electron main re-reports at least every two minutes while it
 *  runs, so a report this old means main stopped reporting — and a presence nobody can vouch for
 *  counts as away, so a push goes rather than waiting on a guess. */
export const PRESENCE_STALE_MS = 5 * 60_000;

/**
 * Whether the owner is at this Mac, for holding pushes back (Plan 28, "When the phone buzzes").
 *
 * Electron main is the only thing that can tell — the screen lock, the idle clock, the windows are
 * all its — and it reports with `presence.set`. Everything it cannot vouch for reads as away: no
 * report yet, a report gone stale, or no Electron attached at all (a headless daemon has nobody at it
 * by definition). Away is the side to fail on: a push that should have waited costs a buzz, and a
 * push that waited on nobody costs the answer an agent is blocked on.
 */
export class Presence {
  private reported: { away: boolean; at: number } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly o: { attached: () => boolean; now?: () => number; staleMs?: number }) {
    this.now = o.now ?? Date.now;
  }

  set(away: boolean): void {
    const was = this.away();
    this.reported = { away, at: this.now() };
    if (this.away() !== was) for (const l of this.listeners) l();
  }

  away(): boolean {
    if (!this.o.attached()) return true;
    const r = this.reported;
    if (!r || this.now() - r.at > (this.o.staleMs ?? PRESENCE_STALE_MS)) return true;
    return r.away;
  }

  /** Called when a report changes the answer — the owner just left, or just came back. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

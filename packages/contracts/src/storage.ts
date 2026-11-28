/**
 * How long a session can go untouched before Realm cuts its long tool output to a head and a tail,
 * in days. 0 keeps every payload whole.
 *
 * **Off by default.** A cut can't be undone, so the owner turns it on. The server's rule is
 * `EventRetention` (`apps/server/src/store/event-retention.ts`); a VACUUM of free pages runs either way.
 */
export const EVENT_RETENTION_DAYS_KEY = "storage.eventRetentionDays";
export const EVENT_RETENTION_DAYS_DEFAULT = 0;
/** Retention runs this often (and first ten minutes after boot), so a new window applies within it. */
export const EVENT_RETENTION_EVERY_HOURS = 6;
/** realm.db is compacted once at least this much of it is unused. */
export const DB_COMPACT_MIN_MB = 64;

/** The stored window as the server applies it and Settings shows it: a number of days, floored to
 *  whole days. Anything else, including a negative number or NaN, is the default, off. */
export function parseRetentionDays(stored: unknown): number {
  return typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? Math.floor(stored) : EVENT_RETENTION_DAYS_DEFAULT;
}

/** The windows Settings offers. */
export const EVENT_RETENTION_CHOICES: readonly { days: number; label: string }[] = [
  { days: 0, label: "Off" }, { days: 30, label: "30 days" }, { days: 90, label: "90 days" },
];

/** The choices for a stored window: the usual three, plus the stored one when it is none of them
 *  (written over RPC, say), so the control always shows what the server will apply. */
export function retentionChoicesFor(days: number): readonly { days: number; label: string }[] {
  return EVENT_RETENTION_CHOICES.some((c) => c.days === days)
    ? EVENT_RETENTION_CHOICES
    : [...EVENT_RETENTION_CHOICES, { days, label: days === 1 ? "1 day" : `${days} days` }].sort((a, b) => a.days - b.days);
}

export const EVENT_RETENTION_COPY = {
  label: "Trim old tool output",
  detail: `Cuts long tool output in sessions untouched this long. Messages stay. This can't be undone. A new choice applies at the next run, within ${EVENT_RETENTION_EVERY_HOURS} hours.`,
  compaction: `Trimming on or off, Realm compacts realm.db while no agent is working once ${DB_COMPACT_MIN_MB} MB or more is unused.`,
  rule: "Long tool output keeps its start and end, with a note of how much was cut. Messages and plans stay whole, and the session still opens. Sessions that are running, waiting on you, moving or pinned are never trimmed, and neither is a teammate's home chat.",
} as const;

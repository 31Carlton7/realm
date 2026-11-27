/**
 * How long a session can go untouched before Realm cuts its long tool output to a head and a tail,
 * in days. 0 keeps every payload whole.
 *
 * **Off by default.** A cut can't be undone, so the owner turns it on. The server's rule is
 * `EventRetention` (`apps/server/src/store/event-retention.ts`); a VACUUM of free pages runs either way.
 */
export const EVENT_RETENTION_DAYS_KEY = "storage.eventRetentionDays";
export const EVENT_RETENTION_DAYS_DEFAULT = 0;

/** The windows Settings offers. A value set some other way still reads as itself on the server. */
export const EVENT_RETENTION_CHOICES: readonly { days: number; label: string }[] = [
  { days: 0, label: "Off" }, { days: 30, label: "30 days" }, { days: 90, label: "90 days" },
];

export const EVENT_RETENTION_COPY = {
  label: "Trim old tool output",
  detail: "Cuts long tool output in sessions untouched for this long. Messages stay. This can't be undone.",
} as const;

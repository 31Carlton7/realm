/**
 * Settings ▸ General ▸ Meetings: whether Realm opens a calendar meeting's link when it starts, with a
 * notification two minutes before. On unless turned off, and it does nothing until macOS says Realm
 * may read the calendar (`main/meeting-watch.ts`).
 */
export const MEETINGS_OPEN_KEY = "meetings.openWhenStarts";
export const MEETINGS_OPEN_DEFAULT = true;

/** Calendar access as macOS reports it for Realm. `writeOnly` can add events and read none. */
export const CALENDAR_ACCESS = ["full", "writeOnly", "denied", "restricted", "notDetermined"] as const;
export type CalendarAccess = (typeof CALENDAR_ACCESS)[number];

export function isCalendarAccess(v: unknown): v is CalendarAccess {
  return (CALENDAR_ACCESS as readonly unknown[]).includes(v);
}

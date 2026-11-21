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

/**
 * The meeting assistant's first-run sheet, accepted: when, in epoch milliseconds. Written once, from
 * the sheet's own button, and never at boot, so an unset key is the honest "not yet". Listening
 * cannot start until it is set, by hand or on its own (M3c reads this before it starts anything).
 */
export const MEETING_CONSENT_KEY = "meetings.assistantConsentAt";

/** Whether the stored value says the first-run sheet was accepted. */
export function meetingConsentAccepted(stored: unknown): boolean {
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0;
}

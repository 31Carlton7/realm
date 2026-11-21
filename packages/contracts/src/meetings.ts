import { z } from "zod";

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

/**
 * Settings ▸ General ▸ Meetings: start the assistant when a calendar meeting starts or a calling app
 * takes the microphone. It does nothing until the first-run sheet has been accepted
 * (`MEETING_CONSENT_KEY`). Off by default until Carlton decides whether it is on for everyone.
 */
export const MEETING_AUTO_START_KEY = "meetings.startAssistantWithCall";
export const MEETING_AUTO_START_DEFAULT = false;

/** Whether the assistant answers a question the other side asks without a key. On unless turned off. */
export const MEETING_AUTO_ANSWERS_KEY = "meetings.autoAnswers";
export const MEETING_AUTO_ANSWERS_DEFAULT = true;

/** What started a live answer: the answer key (Fn G), or a question the other side asked. */
export const LIVE_ANSWER_TRIGGERS = ["key", "question"] as const;
export type LiveAnswerTrigger = (typeof LIVE_ANSWER_TRIGGERS)[number];

/**
 * One step of a live answer, sent only to the window that asked for it. `start` comes first and
 * names the model (null: the CLI's default); then any number of `delta`s, each the next piece of the
 * text; then exactly one of `done` (with the whole text), `error` or `cancelled`. An answer that
 * could not begin sends `error` alone. A newer ask cancels the one before it.
 */
export const LiveAnswerEventSchema = z.discriminatedUnion("t", [
  z.object({ answerId: z.string(), t: z.literal("start"), trigger: z.enum(LIVE_ANSWER_TRIGGERS), model: z.string().nullable() }),
  z.object({ answerId: z.string(), t: z.literal("delta"), text: z.string() }),
  z.object({ answerId: z.string(), t: z.literal("done"), text: z.string() }),
  z.object({ answerId: z.string(), t: z.literal("error"), message: z.string() }),
  z.object({ answerId: z.string(), t: z.literal("cancelled") }),
]);
export type LiveAnswerEvent = z.infer<typeof LiveAnswerEventSchema>;

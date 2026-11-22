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

/** Whether the assistant answers a question the other side asks without a key. On unless turned off. */
export const MEETING_AUTO_ANSWERS_KEY = "meetings.autoAnswers";
export const MEETING_AUTO_ANSWERS_DEFAULT = true;

/** What started a live answer: the answer key (Fn G), a question the other side asked, or the
 *  screen key (Fn S), which sends a picture of the person's screen with the ask. */
export const LIVE_ANSWER_TRIGGERS = ["key", "question", "screen"] as const;
export type LiveAnswerTrigger = (typeof LIVE_ANSWER_TRIGGERS)[number];

/**
 * A picture of the person's screen for a `screen` answer, base64 in the request and nowhere else:
 * the server checks it, hands it to the model and keeps no copy. PNG or JPEG, the two a capture
 * comes out as. `data` is checked for base64 on the server: zod's own check overflows the stack on
 * a picture of a few megabytes.
 */
export const ScreenPictureSchema = z.object({ mediaType: z.enum(["image/png", "image/jpeg"]), data: z.string() }).strict();
export type ScreenPicture = z.infer<typeof ScreenPictureSchema>;

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

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

/** One finished line of a meeting's transcript, as RealmVoice's continuous mode hands it over: "me" is
 *  this Mac's microphone, "them" the other side of the call. `start` and `end` are milliseconds since
 *  the transcript started, `at` the wall-clock time of `start`. */
export const MeetingLineSchema = z.object({
  source: z.enum(["me", "them"]),
  text: z.string().max(4_000),
  start: z.number(),
  end: z.number(),
  at: z.number(),
}).strict();
export type MeetingLine = z.infer<typeof MeetingLineSchema>;

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

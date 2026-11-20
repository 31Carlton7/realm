import { z } from "zod";
import { IdSchema } from "./ids";

/** Where a space keeps its meetings' notes, one Markdown file each, under its primary checkout. */
export const MEETINGS_DIR = "meetings";

/** The title of a meeting that came from no calendar event. */
export const MEETING_DEFAULT_TITLE = "Meeting";

/** One finished line of a meeting's transcript, as `MeetingTranscript` hands it over: `start` and
 *  `end` are milliseconds since the transcript started, `at` the wall-clock time of `start`. */
export const MeetingTranscriptLineSchema = z.object({
  source: z.enum(["me", "them"]),
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  at: z.number(),
});
export type MeetingTranscriptLine = z.infer<typeof MeetingTranscriptLineSchema>;

/**
 * A meeting that has ended, as Stop hands it over. `meetingId` is the caller's own name for this
 * meeting: `meetings.notesProgress` carries it back, and `meetings.cancelSummary` takes it.
 * `customInfo` is what the person typed into the prompter for the assistant; it goes to the model
 * with the transcript and the notes, and is not written to the file.
 */
export const SaveMeetingNotesParamsSchema = z.object({
  meetingId: z.string().min(1).max(100),
  spaceId: IdSchema,
  title: z.string().default(MEETING_DEFAULT_TITLE),
  startedAt: z.number(),
  endedAt: z.number(),
  lines: z.array(MeetingTranscriptLineSchema),
  notes: z.string().default(""),
  customInfo: z.string().default(""),
});
export type SaveMeetingNotesParams = z.infer<typeof SaveMeetingNotesParamsSchema>;

/**
 * How the summary came out. The file is written in every case.
 * - `written`: the model's summary is in the file.
 * - `empty`: nothing was said and nothing was noted, so no model was asked.
 * - `unavailable`: the quick chat model's agent is not installed or not signed in.
 * - `failed`: the model call failed, or its answer had no summary in it.
 * - `cancelled`: `meetings.cancelSummary` stopped it.
 */
export const MeetingSummaryOutcomeSchema = z.enum(["written", "empty", "unavailable", "failed", "cancelled"]);
export type MeetingSummaryOutcome = z.infer<typeof MeetingSummaryOutcomeSchema>;

/** `path` is relative to the space's primary checkout, as `documents.openPath` takes it. */
export const SaveMeetingNotesResultSchema = z.object({ path: z.string(), summary: MeetingSummaryOutcomeSchema });
export type SaveMeetingNotesResult = z.infer<typeof SaveMeetingNotesResultSchema>;

/**
 * `summarising`: the file is on disk with the notes and the transcript, and the model is writing the
 * summary. `saved`: the file is final.
 */
export const MeetingNotesProgressSchema = z.object({
  meetingId: z.string(),
  spaceId: IdSchema,
  path: z.string(),
  stage: z.enum(["summarising", "saved"]),
});
export type MeetingNotesProgress = z.infer<typeof MeetingNotesProgressSchema>;

/** One meeting's file in a space's `meetings/` folder, as the Documents home lists it. `path` is
 *  relative to the space's primary checkout; `modifiedAt` is epoch milliseconds. */
export const MeetingNotesFileSchema = z.object({ path: z.string(), modifiedAt: z.number() });
export type MeetingNotesFile = z.infer<typeof MeetingNotesFileSchema>;

import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * A turn the reader saved from a session's scroll track — and found again in the Library's Saved
 * section, across every session of the profile.
 *
 * What is KEPT is the prompt's own event: the seq of its `user_message`, and when it was saved. The
 * words are read back off that event every time the list is drawn, never copied, so a saved turn can
 * only ever say what the session says, and it goes when the event does (a rewind, the session's
 * deletion) rather than outliving it as a quote of something no longer there.
 */
export const SavedTurnSchema = z.object({
  sessionId: IdSchema,
  /** The prompt's `user_message` event — the one thing stored. */
  seq: z.number().int(),
  savedAt: z.number(),
  /** When the prompt was sent. */
  ts: z.number(),
  /** The prompt as it was sent, and what stands in for its words when it has none: the files an
   *  attachment-only message carried, and the kind of turn a goal started on its own. */
  text: z.string(),
  attachments: z.array(z.string()),
  goal: z.enum(["continuation", "budget"]).nullable(),
  /** The first stretch of the answer the turn got, or null for a turn nothing has answered yet. */
  reply: z.string().nullable(),
  sessionTitle: z.string(),
  spaceId: IdSchema,
});
export type SavedTurn = z.infer<typeof SavedTurnSchema>;

/** The most saved turns the Library lists at once. A saved list is a person's own short list, and
 *  this is far past it — but a cap is stated, never silent: the read says how many there are. */
export const SAVED_TURNS_MAX = 500;
/** How much of an answer a saved turn carries: past what its card's three lines can show. */
export const SAVED_REPLY_MAX = 600;

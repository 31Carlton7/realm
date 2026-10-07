/**
 * The one place that reads `Checkpoint.providerCursor`.
 *
 * `providerCursor` is opaque on the wire and in the database on purpose — the shape belongs to whichever
 * adapter wrote it, and a second agent that gains a truncating resume will store something else
 * entirely. This file is the CLAUDE reading of it, kept server-side rather than in the adapter for one
 * reason: the adapter never sees a checkpoint. It is handed two uuids at start and reports two back at
 * settle; pairing those with a row in `checkpoints` is the server's job, so the format the server
 * persists is written down where the server persists it.
 *
 * The pair is stored as JSON and not as `"<at>:<dropsTurn>"`. A uuid contains no colon today, which is
 * precisely the kind of fact that makes a delimiter format work right up until it silently does not.
 *
 * Decoding is total and forgiving. Every reader of a cursor is deciding whether a rewind is possible,
 * and the honest answer for anything unrecognised — a row from a build that encoded it differently,
 * truncated JSON, a cursor written by an adapter that is no longer this session's — is "no", never a
 * throw on a path whose whole job is to restore somebody's files.
 */

/**
 * What the CLI answers when the guard fires (`sdk.d.ts`, `Options.resumeDropsTurn`): an
 * `error_during_execution` result whose message starts with this.
 *
 * Matched as a PREFIX because the rest of the line names what was found in the discarded range, and
 * that diagnostic is the whole value of the refusal — it is kept verbatim as the evidence rather than
 * normalised into a code of Realm's own.
 */
export const REWIND_REFUSAL_PREFIX = "Resume rejected by --resume-drops-turn:";

/**
 * Whether this error message is the fork guard refusing.
 *
 * `includes`, not `startsWith`, and the difference matters: by the time a refusal reaches
 * `SessionService` the adapter has already appended its stderr tail to the message (`withStderr`), and
 * a result-carried error can arrive joined to siblings. The prefix is specific enough that a false
 * positive would have to be a message quoting the CLI's own refusal, and treating that as a refusal is
 * the safe direction — it costs a fork Realm would otherwise have armed, and never a retry loop.
 */
export function isRewindRefusal(message: string): boolean {
  return message.includes(REWIND_REFUSAL_PREFIX);
}

/**
 * Where a Claude conversation stood: the provider session the uuids belong to, and the two uuids a
 * truncating resume needs.
 *
 * - `session` — the provider session id the other two were observed in. Carried because the SDK FORKS
 *   to a new session id on every resume (`AGENT_SESSION_RESUME.claude` says so, and `ClaudeAdapter`'s
 *   options comment says it again): a uuid is a position in ONE chain, and nothing the SDK documents
 *   promises that a forked chain keeps its ancestor's uuids. So a cursor is usable only while the
 *   session still names the id it was recorded under, and Realm reports no rewind once that has moved
 *   rather than guessing. If the CLI ever documents uuid stability across a resume fork, this field is
 *   what gets relaxed — and until it does, the strictness costs an occasional rewind and never costs a
 *   wrong one.
 * - `at` — the KEPT turn's last chain entry, which is what `resumeSessionAt` wants. Not the kept turn's
 *   last assistant message: an end-turn tool session ends on a tool_result carrier, an interrupted turn
 *   on a completed tool_result, and forking before either leaves the kept turn's own payload in the
 *   discarded range, which the validator deliberately refuses.
 * - `dropsTurn` — the prompt uuid of the turn the truncation means to discard, which is what
 *   `resumeDropsTurn` declares. It is the prompt of the turn the checkpoint carrying this cursor was
 *   captured in front of.
 *
 * All three or none. A cursor with a fork point but no `dropsTurn` would have to be sent as an
 * UNGUARDED truncation (the SDK's behaviour when `resumeDropsTurn` is omitted), which would silently
 * discard a queued message or a task notification the session absorbed mid-turn — the exact class of
 * loss the guard exists to make impossible.
 */
export type ProviderCursor = { session: string; at: string; dropsTurn: string };

/**
 * Where the provider's chain stands right now, on the SESSION row — one chain position, with the
 * session that gives it meaning.
 *
 * The smaller sibling of `ProviderCursor`, and smaller for a reason rather than by omission: a session
 * has no turn to drop. It has an end, and the end of the last settled turn is what the NEXT turn's
 * checkpoint will fork to. `dropsTurn` only becomes knowable once that next turn has been sent, which
 * is why it is a property of a checkpoint and never of a session.
 */
export type SessionCursor = { session: string; at: string };

export function encodeSessionCursor(cursor: SessionCursor): string {
  return JSON.stringify({ session: cursor.session, at: cursor.at });
}

export function decodeSessionCursor(raw: string | null): SessionCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const { session, at } = parsed as { session?: unknown; at?: unknown };
  if (typeof session !== "string" || session === "" || typeof at !== "string" || at === "") return null;
  return { session, at };
}

export function encodeProviderCursor(cursor: ProviderCursor): string {
  return JSON.stringify({ session: cursor.session, at: cursor.at, dropsTurn: cursor.dropsTurn });
}

export function decodeProviderCursor(raw: string | null): ProviderCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const { session, at, dropsTurn } = parsed as { session?: unknown; at?: unknown; dropsTurn?: unknown };
  if (typeof session !== "string" || session === "") return null;
  if (typeof at !== "string" || at === "" || typeof dropsTurn !== "string" || dropsTurn === "") return null;
  return { session, at, dropsTurn };
}

/**
 * A fork a restore has armed and nothing has consumed yet.
 *
 * It carries the checkpoint id alongside the cursor because the refusal path has to reach back to the
 * ROW: a fork the CLI has rejected is rejected deterministically, so the cursor that produced it is
 * cleared from the checkpoint and can never be armed again. Without the id here, a refusal could only
 * clear the session's arm, and the very next restore of the same checkpoint would re-send the request
 * the CLI has already refused.
 */
export type ArmedRewind = ProviderCursor & { checkpointId: string };

export function encodeArmedRewind(fork: ArmedRewind): string {
  return JSON.stringify({ session: fork.session, at: fork.at, dropsTurn: fork.dropsTurn, checkpointId: fork.checkpointId });
}

export function decodeArmedRewind(raw: string | null): ArmedRewind | null {
  const cursor = decodeProviderCursor(raw);
  if (!cursor || !raw) return null;
  const { checkpointId } = JSON.parse(raw) as { checkpointId?: unknown };
  if (typeof checkpointId !== "string" || checkpointId === "") return null;
  return { ...cursor, checkpointId };
}

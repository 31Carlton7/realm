import { describe, expect, it } from "vitest";
import {
  REWIND_REFUSAL_PREFIX, decodeArmedRewind, decodeProviderCursor, decodeSessionCursor,
  encodeArmedRewind, encodeProviderCursor, encodeSessionCursor, isRewindRefusal,
} from "./rewind";

describe("provider cursor", () => {
  it("round-trips the three fields a truncating resume needs", () => {
    const cursor = { session: "prov-1", at: "uuid-end", dropsTurn: "uuid-prompt" };
    expect(decodeProviderCursor(encodeProviderCursor(cursor))).toEqual(cursor);
  });

  it("refuses a cursor missing any one of them", () => {
    /* The named mutant: relaxing any of these three checks. `dropsTurn` missing is the dangerous one —
       it would be stored as a usable cursor, sent as `resumeSessionAt` alone, and the SDK would then
       perform an UNVALIDATED truncation that silently discards whatever else sat past the fork point.
       `session` missing is the second: the uuids would be used against a chain that may not hold them. */
    expect(decodeProviderCursor(JSON.stringify({ at: "a", dropsTurn: "p" }))).toBeNull();
    expect(decodeProviderCursor(JSON.stringify({ session: "s", dropsTurn: "p" }))).toBeNull();
    expect(decodeProviderCursor(JSON.stringify({ session: "s", at: "a" }))).toBeNull();
    // Empty strings are absences wearing a type: a uuid of "" names no chain entry.
    expect(decodeProviderCursor(JSON.stringify({ session: "s", at: "", dropsTurn: "p" }))).toBeNull();
  });

  it("answers null for every shape a database can hand back, rather than throwing", () => {
    // Every caller is deciding whether a rewind is possible, on a path whose other job is restoring
    // somebody's files. "No" is always available; throwing is not.
    for (const raw of [null, "", "not json", "[]", "12", '{"at":', '{"session":1,"at":2,"dropsTurn":3}']) {
      expect(decodeProviderCursor(raw), raw ?? "null").toBeNull();
    }
  });
});

describe("session cursor", () => {
  it("round-trips, and carries no dropsTurn — a session has no turn to drop", () => {
    expect(decodeSessionCursor(encodeSessionCursor({ session: "p", at: "u" }))).toEqual({ session: "p", at: "u" });
    expect(decodeSessionCursor(JSON.stringify({ session: "p" }))).toBeNull();
  });

  it("does not accept a provider cursor's extra field as a reason to reject", () => {
    // The session cursor is the prefix of the checkpoint one, so a value written by a newer build that
    // added a field still reads: the two uuids it names are the two this needs.
    expect(decodeSessionCursor(encodeProviderCursor({ session: "p", at: "u", dropsTurn: "q" })))
      .toEqual({ session: "p", at: "u" });
  });
});

describe("armed rewind", () => {
  it("round-trips the cursor plus the checkpoint that armed it", () => {
    const fork = { session: "prov-1", at: "u-end", dropsTurn: "u-prompt", checkpointId: "cp1" };
    expect(decodeArmedRewind(encodeArmedRewind(fork))).toEqual(fork);
  });

  it("refuses an arm with no checkpoint id", () => {
    /* The mutant: dropping `checkpointId` from the arm. Nothing would break at boot — the fork would
       still be sent — and the refusal path would then have no row to reach back to, so the rejected
       cursor would stay on the checkpoint and be armed again by the next restore of it. */
    expect(decodeArmedRewind(encodeProviderCursor({ session: "p", at: "u", dropsTurn: "q" }))).toBeNull();
  });

  it("refuses an arm whose cursor is incomplete, even with a checkpoint id", () => {
    expect(decodeArmedRewind(JSON.stringify({ session: "p", at: "u", checkpointId: "cp1" }))).toBeNull();
  });
});

describe("isRewindRefusal", () => {
  it("recognises the CLI's documented refusal", () => {
    expect(isRewindRefusal(`${REWIND_REFUSAL_PREFIX} entry 3 is not attributable to the declared turn`)).toBe(true);
  });

  it("still recognises it once the adapter has appended its stderr tail", () => {
    // `ClaudeAdapter.withStderr` wraps a failure with the last 50 stderr lines, so by the time this
    // message reaches SessionService the prefix is no longer at position 0. A `startsWith` here would
    // miss every real refusal and let failover retry a request that can only fail again.
    const wrapped = `${REWIND_REFUSAL_PREFIX} queued user message\n--- stderr (last 2 lines) ---\nfoo\nbar`;
    expect(isRewindRefusal(wrapped)).toBe(true);
  });

  it("does not claim an ordinary failure", () => {
    expect(isRewindRefusal("agent process ended unexpectedly")).toBe(false);
    expect(isRewindRefusal("Resume rejected")).toBe(false); // a prefix of the prefix is not the prefix
    expect(isRewindRefusal("")).toBe(false);
  });
});

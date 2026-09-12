import { describe, expect, it } from "vitest";
import { HINT_MAX, cleanHint } from "./generate-prompt-hint";

/**
 * The hint's cleanup, which is where every model habit this feature has to survive gets handled.
 *
 * `cleanHint` throws for a decline exactly as it does for a failure, and that is deliberate: both
 * mean the same thing to the caller — keep the deterministic ladder — so both leave by one door.
 */
describe("cleanHint", () => {
  it("takes a plain answer as it is", () => {
    expect(cleanHint("Write tests for map-codex.ts.")).toBe("Write tests for map-codex.ts.");
  });

  it("strips the wrappers a model adds when it is being helpful", () => {
    // All three measured shapes: quoted, bulleted, and trailing whitespace.
    expect(cleanHint('"Write tests for it."')).toBe("Write tests for it.");
    expect(cleanHint("- Write tests for it.")).toBe("Write tests for it.");
    expect(cleanHint("• Write tests for it.")).toBe("Write tests for it.");
    expect(cleanHint("  Write tests for it.  \n")).toBe("Write tests for it.");
    expect(cleanHint("“Write tests for it.”")).toBe("Write tests for it.");
  });

  it("keeps only the first line, so a model that explained itself does not fill the box", () => {
    expect(cleanHint("Write tests for it.\n\nThis follows from the diff above.")).toBe("Write tests for it.");
  });

  /* A decline is the EXPECTED answer on a good many turns — a greeting, a finished one-off question.
     It has to be as cheap as a success, and it must not read as a fault anywhere upstream. */
  it("treats a decline as a throw, in every casing the brief invites", () => {
    for (const raw of ["NONE", "none", "None.", " none "]) {
      expect(() => cleanHint(raw), raw).toThrow(/declined/);
    }
  });

  it("treats an empty answer as the same outcome as a decline", () => {
    expect(() => cleanHint("")).toThrow(/declined/);
    expect(() => cleanHint("   \n  ")).toThrow(/declined/);
  });

  /* Over budget is a brief the model ignored, and the answer is discarded rather than clipped: the
     hint is filled into the composer by ⇥ and SENT, so a mid-word cut would put an ellipsis in the
     user's outgoing message. The summary clips because nobody sends a summary. */
  it("discards an over-long answer rather than clipping it into the user's message", () => {
    const long = `${"Refactor the adapter layer and ".repeat(4)}please.`;
    expect(long.length).toBeGreaterThan(HINT_MAX);
    expect(() => cleanHint(long)).toThrow(/too long/);
  });

  it("accepts an answer exactly at the ceiling", () => {
    const exact = "a".repeat(HINT_MAX);
    expect(cleanHint(exact)).toBe(exact);
  });
});

import { describe, expect, it } from "vitest";
import { meetingConsentAccepted } from "./meetings";

describe("meetingConsentAccepted", () => {
  it("reads a time as accepted, and anything else as not yet", () => {
    expect(meetingConsentAccepted(1_763_683_200_000)).toBe(true);
    for (const v of [undefined, null, 0, -1, NaN, Infinity, "1763683200000", true, {}]) expect(meetingConsentAccepted(v)).toBe(false);
  });
});

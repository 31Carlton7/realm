import { describe, expect, it } from "vitest";
import { LIVE_ANSWER_TRIGGERS, meetingConsentAccepted } from "./meetings";
import { Methods } from "./rpc";

const params = Methods["meetings.answer"].params;
const ask = { lines: [], customInfo: "", trigger: "screen" as const };

describe("meetings.answer with a picture of the screen", () => {
  it("has a screen trigger", () => {
    expect(LIVE_ANSWER_TRIGGERS).toContain("screen");
    expect(params.safeParse({ lines: [], customInfo: "", trigger: "screen" }).success).toBe(true);
  });

  it("takes a PNG or a JPEG", () => {
    for (const mediaType of ["image/png", "image/jpeg"]) {
      expect(params.safeParse({ ...ask, screen: { mediaType, data: "iVBORw0KGgo=" } }).success, mediaType).toBe(true);
    }
  });

  it("takes no other kind of picture, and nothing beside the picture's type and bytes", () => {
    for (const mediaType of ["image/gif", "image/webp", "image/heic", "application/pdf"]) {
      expect(params.safeParse({ ...ask, screen: { mediaType, data: "R0lGODlh" } }).success, mediaType).toBe(false);
    }
    expect(params.safeParse({ ...ask, screen: { mediaType: "image/png", data: "iVBORw0KGgo=", path: "/tmp/shot.png" } }).success).toBe(false);
    expect(params.safeParse({ ...ask, screen: { mediaType: "image/png" } }).success).toBe(false);
    expect(params.safeParse({ ...ask, screen: "iVBORw0KGgo=" }).success).toBe(false);
  });
});

describe("meetingConsentAccepted", () => {
  it("reads a time as accepted, and anything else as not yet", () => {
    expect(meetingConsentAccepted(1_763_683_200_000)).toBe(true);
    for (const v of [undefined, null, 0, -1, NaN, Infinity, "1763683200000", true, {}]) expect(meetingConsentAccepted(v)).toBe(false);
  });
});

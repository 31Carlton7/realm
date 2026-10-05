import { describe, expect, it } from "vitest";
import { Methods, RpcRequestSchema, parseWireMessage } from "./rpc";

describe("rpc envelope", () => {
  it("rejects garbage", () => {
    expect(() => parseWireMessage("{}")).toThrow();
    expect(RpcRequestSchema.safeParse({ id: 1 }).success).toBe(false);
  });
});

describe("sessions.send params (Plan 14 W5 — attachment-only messages)", () => {
  const schema = Methods["sessions.send"].params;
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  it("accepts text alone and attachments alone", () => {
    expect(schema.safeParse({ id, text: "hi" }).success).toBe(true);
    expect(schema.safeParse({ id, text: "", attachments: [{ path: "/a.png", mime: "image/png" }] }).success).toBe(true);
  });
  it("REFUSES empty text with zero attachments — a message that says nothing at all", () => {
    // The named mutant: relaxing text.min(1) must not open the door to genuinely empty sends.
    expect(schema.safeParse({ id, text: "" }).success).toBe(false);
    expect(schema.safeParse({ id, text: "", attachments: [] }).success).toBe(false);
  });
});

describe("laya.record params", () => {
  const schema = Methods["laya.record"].params;
  const simulatorId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  it("takes apps by the names they call themselves, or none for the app in front", () => {
    expect(schema.parse({ simulatorId })).toEqual({ simulatorId, apps: [] });
    expect(schema.parse({ simulatorId, apps: [" Instagram ", "TikTok"] }).apps).toEqual(["Instagram", "TikTok"]);
  });
  it("refuses a name with no letter or digit in it — it would fold to the home screen's nothing", () => {
    for (const bad of ["…", " - ", "!!"]) expect(schema.safeParse({ simulatorId, apps: [bad] }).success, bad).toBe(false);
  });
});

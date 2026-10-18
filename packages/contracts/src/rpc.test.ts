import { describe, expect, it } from "vitest";
import { Methods, RpcRequestSchema, parseWireMessage } from "./rpc";
import { TEAMMATE_BRIEF_MAX } from "./delegation";

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

describe("delegation.addTeammate params", () => {
  const schema = Methods["delegation.addTeammate"].params;
  const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  it("needs only the session: the harness, the model and the brief are the session's own when left out, and the checkout is its folder", () => {
    expect(schema.parse({ sessionId })).toEqual({ sessionId, newWorktree: false });
    expect(schema.parse({ sessionId, agentKind: "codex", model: " gpt-6-luna ", brief: "  Write the tests ", newWorktree: true }))
      .toEqual({ sessionId, agentKind: "codex", model: "gpt-6-luna", brief: "Write the tests", newWorktree: true });
  });
  it("refuses a brief longer than one line of the picker can hold, and a harness Realm does not have", () => {
    expect(schema.safeParse({ sessionId, brief: "x".repeat(TEAMMATE_BRIEF_MAX) }).success).toBe(true);
    expect(schema.safeParse({ sessionId, brief: "x".repeat(TEAMMATE_BRIEF_MAX + 1) }).success).toBe(false);
    expect(schema.safeParse({ sessionId, agentKind: "notanagent" }).success).toBe(false);
  });
});

describe("delegation.children result", () => {
  it("reads a server from before dismissal existed as nothing dismissed", () => {
    expect(Methods["delegation.children"].result.parse({ children: [] })).toEqual({ children: [], dismissed: [] });
  });
});

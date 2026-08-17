import { describe, expect, it } from "vitest";
import { RpcRequestSchema, RpcResponseSchema, RpcEventSchema, parseWireMessage } from "./rpc";

describe("rpc envelope", () => {
  it("parses a request", () => {
    const m = parseWireMessage(JSON.stringify({ id: "1", method: "profiles.list", params: {} }));
    expect(m.kind).toBe("request");
  });
  it("parses ok and error responses", () => {
    expect(RpcResponseSchema.parse({ id: "1", ok: true, result: [] }).ok).toBe(true);
    expect(RpcResponseSchema.parse({ id: "1", ok: false, error: { code: "NOT_FOUND", message: "x" } }).ok).toBe(false);
  });
  it("parses an event", () => {
    expect(RpcEventSchema.parse({ event: "spaces.changed", payload: {} }).event).toBe("spaces.changed");
  });
  it("rejects garbage", () => {
    expect(() => parseWireMessage("{}")).toThrow();
    expect(RpcRequestSchema.safeParse({ id: 1 }).success).toBe(false);
  });
});

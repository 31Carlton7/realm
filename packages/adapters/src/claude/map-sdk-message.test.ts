import { describe, expect, it } from "vitest"; import { readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createSdkMapper } from "./map-sdk-message";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "turn.json"), "utf8")) as unknown[];
describe("map-sdk-message", () => {
  it("maps a recorded turn to normalized events", () => {
    const m = createSdkMapper(); const out = fixture.flatMap((msg) => m.map(msg as never));
    const types = out.map((e) => e.type);
    expect(types[0]).toBe("init");
    expect(types).toContain("assistant_delta"); expect(types).toContain("assistant_text"); expect(types).toContain("tool_call"); expect(types).toContain("tool_result"); expect(types).toContain("usage");
    const call = out.find((e) => e.type === "tool_call")!; expect(call.type === "tool_call" && call.payload.name).toBe("Read");
    const res = out.find((e) => e.type === "tool_result")!; expect(res.type === "tool_result" && res.payload.toolUseId).toBe("toolu_01");
    const usage = out.find((e) => e.type === "usage")!; expect(usage.type === "usage" && usage.payload.numTurns).toBe(2);
  });
});

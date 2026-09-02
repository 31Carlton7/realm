import { describe, expect, it } from "vitest";
import { generateSessionTitle } from "./generate-session-title";

type Msg = { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution"; result?: string };
const fakeQuery = (msgs: Msg[]) => (() => (async function* () { for (const m of msgs) yield m as never; })()) as never;

describe("generateSessionTitle", () => {
  it("returns the model's title, trimmed of quotes and trailing punctuation", async () => {
    const title = await generateSessionTitle("fix the login flow", {
      query: fakeQuery([{ type: "result", subtype: "success", result: '"Fix the login flow."' }]),
    });
    expect(title).toBe("Fix the login flow");
  });

  it("clips an overlong title the same way titleFromMessage clips the heuristic one", async () => {
    const long = "a".repeat(60);
    const title = await generateSessionTitle("x", { query: fakeQuery([{ type: "result", subtype: "success", result: long }]) });
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith("…")).toBe(true);
  });

  it("throws on a non-success result instead of returning a blank or garbage title", async () => {
    await expect(generateSessionTitle("x", { query: fakeQuery([{ type: "result", subtype: "error_max_turns" }]) }))
      .rejects.toThrow(/title generation failed/);
  });

  it("throws when the model returns nothing usable", async () => {
    await expect(generateSessionTitle("x", { query: fakeQuery([{ type: "result", subtype: "success", result: "   " }]) }))
      .rejects.toThrow(/no text/);
  });
});

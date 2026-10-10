import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSvgIcon } from "./generate-svg-icon";

type Msg = { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution"; result?: string };
const fakeQuery = (msgs: Msg[]) => (() => (async function* () { for (const m of msgs) yield m as never; })()) as never;

const ICON = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>';

describe("generateSvgIcon", () => {
  it("returns the model's SVG, cut out of the fences and prose it was told not to add", async () => {
    const svg = await generateSvgIcon("a compass", {
      query: fakeQuery([{ type: "result", subtype: "success", result: `Here is your icon:\n\`\`\`svg\n${ICON}\n\`\`\`\nEnjoy.` }]),
    });
    expect(svg).toBe(ICON);
  });

  it("throws on a non-success result instead of returning a blank or half-drawn icon", async () => {
    await expect(generateSvgIcon("a compass", { query: fakeQuery([{ type: "result", subtype: "error_max_turns" }]) }))
      .rejects.toThrow(/icon generation failed/);
  });

  it("throws when the answer holds no SVG markup", async () => {
    await expect(generateSvgIcon("a compass", { query: fakeQuery([{ type: "result", subtype: "success", result: "I can't draw that." }]) }))
      .rejects.toThrow(/no SVG markup/);
  });
});

/** A stand-in for `query()` that answers with one good icon and keeps the options it was called
 *  with, which is where the sign-in an icon rides on is decided. */
const answering = (seen: Record<string, unknown>[]) =>
  ((args: { options: Record<string, unknown> }) => {
    seen.push(args.options);
    return (async function* () { yield { type: "result", subtype: "success", result: ICON } as never; })();
  }) as never;

/**
 * A made-up variable that stands for everything a child process inherits. The tests look for this
 * one and never compare whole environments, so a failure prints one made-up value and not the
 * environment of whoever ran the suite.
 */
const INHERITED = "REALM_TEST_INHERITED";

describe("the sign-in an icon rides on", () => {
  const WORK = "/Users/mara/.claude-work";
  afterEach(() => { vi.unstubAllEnvs(); });

  it("passes no env at all where no folder is named, so the call is the one it always was", async () => {
    for (const named of [{}, { configDir: null }, { configDir: undefined }]) {
      const seen: Record<string, unknown>[] = [];
      await generateSvgIcon("a compass", { query: answering(seen), ...named });
      expect(Object.keys(seen[0]!), JSON.stringify(named)).not.toContain("env");
    }
  });

  it("runs under a named folder with the process's own environment beneath it, since a CLI without PATH does not start", async () => {
    vi.stubEnv(INHERITED, "kept");
    const seen: Record<string, unknown>[] = [];
    await generateSvgIcon("a compass", { query: answering(seen), configDir: WORK });
    expect(seen[0]!.env).toMatchObject({ [INHERITED]: "kept", CLAUDE_CONFIG_DIR: WORK });
  });

  it("puts the named folder above a CLAUDE_CONFIG_DIR that Realm itself was started with", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/Users/mara/.claude-personal");
    const seen: Record<string, unknown>[] = [];
    await generateSvgIcon("a compass", { query: answering(seen), configDir: WORK });
    expect(seen[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: WORK });
  });

  it("leaves the process's own environment as it was, so the next icon with no folder named still rides the default sign-in", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/Users/mara/.claude-personal");
    await generateSvgIcon("a compass", { query: answering([]), configDir: WORK });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/Users/mara/.claude-personal");
  });
});

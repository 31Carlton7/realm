import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A stand-in for `query()` that answers with one good title and keeps the options it was called
 *  with, which is where the sign-in a title rides on is decided. */
const answering = (seen: Record<string, unknown>[]) =>
  ((args: { options: Record<string, unknown> }) => {
    seen.push(args.options);
    return (async function* () { yield { type: "result", subtype: "success", result: "Fix the login flow" } as never; })();
  }) as never;

/**
 * A made-up variable that stands for everything a child process inherits. The tests look for this
 * one and never compare whole environments, so a failure prints one made-up value and not the
 * environment of whoever ran the suite.
 */
const INHERITED = "REALM_TEST_INHERITED";

describe("the sign-in a title rides on", () => {
  const WORK = "/Users/mara/.claude-work";
  afterEach(() => { vi.unstubAllEnvs(); });

  it("passes no env at all where no folder is named, so the call is the one it always was", async () => {
    for (const named of [{}, { configDir: null }, { configDir: undefined }]) {
      const seen: Record<string, unknown>[] = [];
      await generateSessionTitle("fix the login flow", { query: answering(seen), ...named });
      expect(Object.keys(seen[0]!), JSON.stringify(named)).not.toContain("env");
    }
  });

  it("runs under a named folder with the process's own environment beneath it, since a CLI without PATH does not start", async () => {
    vi.stubEnv(INHERITED, "kept");
    const seen: Record<string, unknown>[] = [];
    await generateSessionTitle("fix the login flow", { query: answering(seen), configDir: WORK });
    expect(seen[0]!.env).toMatchObject({ [INHERITED]: "kept", CLAUDE_CONFIG_DIR: WORK });
  });

  it("puts the named folder above a CLAUDE_CONFIG_DIR that Realm itself was started with", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/Users/mara/.claude-personal");
    const seen: Record<string, unknown>[] = [];
    await generateSessionTitle("fix the login flow", { query: answering(seen), configDir: WORK });
    expect(seen[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: WORK });
  });

  it("leaves the process's own environment as it was, so the next title with no folder named still rides the default sign-in", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/Users/mara/.claude-personal");
    await generateSessionTitle("fix the login flow", { query: answering([]), configDir: WORK });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/Users/mara/.claude-personal");
  });
});

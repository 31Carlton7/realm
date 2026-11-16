import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveExecutionSandboxPolicy } from "../sandbox/policy";
import { sandboxCommand } from "../sandbox/spawn";
import { CODEX_TOOL_OUTPUT_BYTES, PREVIEW_BYTES, TOOL_RESULT_KEPT_DAYS, ToolResultFiles, toolResultsRoot, wireBytes } from "./tool-results";

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: false });
const answerOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
const savedIn = (home: string, sessionId: string): string[] => {
  const dir = join(toolResultsRoot(home), sessionId);
  return existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : [];
};

/** Records like the live check's stub: no whitespace to minify, a nested array so no table. */
const denseJson = (bytes: number): string => {
  const rows: string[] = [];
  let size = 2;
  for (let i = 0; size < bytes; i++) {
    const row = JSON.stringify({ i, id: `r${String(i).padStart(6, "0")}`, h: (i * 2654435761).toString(16).padStart(16, "0"), n: [i % 997, i % 991, i % 983], t: i * 7 });
    rows.push(row);
    size += row.length + 1;
  }
  return `[${rows.join(",")}]`;
};

describe("which results are saved", () => {
  it("saves a Codex result whose text would not fit in what Codex keeps, and answers with where it is", async () => {
    const home = tempDir("realm-tool-results-");
    const files = new ToolResultFiles({ home });
    const big = denseJson(56_000);
    const answer = answerOf(await files.spill("s1", "codex", text(big)));
    const [path] = savedIn(home, "s1");
    expect(path).toMatch(/[0-9a-f-]{36}\.txt$/);
    expect(readFileSync(path!, "utf8")).toBe(big);
    expect(answer).toContain(path!);
    expect(answer).toContain(`${Buffer.byteLength(big).toLocaleString("en-US")} bytes`);
    expect(answer).toContain(`kept for ${TOOL_RESULT_KEPT_DAYS} days`);
  });

  it("measures the text as it travels, escaped: dense JSON under 40,000 bytes can still be too long", async () => {
    // 35,000 raw bytes is inside Codex's 40,000; escaped, every quote costs two, and it is not.
    const json = denseJson(35_000);
    expect(Buffer.byteLength(json)).toBeLessThan(CODEX_TOOL_OUTPUT_BYTES);
    expect(wireBytes(json)).toBeGreaterThan(CODEX_TOOL_OUTPUT_BYTES);
    const home = tempDir("realm-tool-results-");
    await new ToolResultFiles({ home }).spill("s1", "codex", text(json));
    expect(savedIn(home, "s1")).toHaveLength(1);
  });

  it("leaves a result alone up to the line, and saves it one byte past", async () => {
    const home = tempDir("realm-tool-results-");
    const files = new ToolResultFiles({ home });
    const fits = "a".repeat(CODEX_TOOL_OUTPUT_BYTES - 1_000 - 2);
    expect(wireBytes(fits)).toBe(CODEX_TOOL_OUTPUT_BYTES - 1_000);
    const same = text(fits);
    expect(await files.spill("s1", "codex", same)).toBe(same);
    expect(savedIn(home, "s1")).toHaveLength(0);
    await files.spill("s1", "codex", text(`${fits}a`));
    expect(savedIn(home, "s1")).toHaveLength(1);
  });

  it("joins a result's text parts into the one file", async () => {
    const home = tempDir("realm-tool-results-");
    const half = "b".repeat(30_000);
    await new ToolResultFiles({ home }).spill("s1", "codex", { content: [{ type: "text", text: half }, { type: "text", text: half }] });
    expect(readFileSync(savedIn(home, "s1")[0]!, "utf8")).toBe(`${half}\n${half}`);
  });

  it("passes a result with an image through as it is, however long its text", async () => {
    const home = tempDir("realm-tool-results-");
    const withImage: CallToolResult = { content: [{ type: "text", text: "c".repeat(60_000) }, { type: "image", data: "aGk=", mimeType: "image/png" }] };
    expect(await new ToolResultFiles({ home }).spill("s1", "codex", withImage)).toBe(withImage);
    expect(existsSync(toolResultsRoot(home))).toBe(false);
  });

  it("writes nothing for an engine that saves its own long results", async () => {
    const home = tempDir("realm-tool-results-");
    const files = new ToolResultFiles({ home });
    const big = text(denseJson(56_000));
    for (const kind of ["claude", "acp:gemini", "acp:opencode"] as const) {
      expect(await files.spill(`s-${kind}`, kind, big)).toBe(big);
    }
    expect(await files.spill("s-none", undefined, big)).toBe(big);
    expect(existsSync(toolResultsRoot(home))).toBe(false);
  });
});

describe("what the agent is answered", () => {
  it("starts with the result itself, and arrives whole inside what Codex keeps", async () => {
    const home = tempDir("realm-tool-results-");
    const big = denseJson(56_000);
    const answer = answerOf(await new ToolResultFiles({ home }).spill("s1", "codex", text(big)));
    const preview = answer.split("\n")[2]!;
    expect(big.startsWith(preview)).toBe(true);
    expect(wireBytes(preview)).toBeLessThanOrEqual(PREVIEW_BYTES);
    expect(wireBytes(preview)).toBeGreaterThan(PREVIEW_BYTES - 100);
    expect(wireBytes(answer)).toBeLessThan(CODEX_TOOL_OUTPUT_BYTES / 2);
    expect(answer.split("\n").at(-1)).toBe(`[Realm: cut here. The whole result is in ${savedIn(home, "s1")[0]}]`);
  });

  it("never cuts a character in two at the end of the preview", async () => {
    const home = tempDir("realm-tool-results-");
    const answer = answerOf(await new ToolResultFiles({ home }).spill("s1", "codex", text("😀".repeat(20_000))));
    expect(answer.split("\n")[2]!).toMatch(/^(😀)+$/u);
  });

  it("keeps the result's isError", async () => {
    const home = tempDir("realm-tool-results-");
    const failed = await new ToolResultFiles({ home }).spill("s1", "codex", { content: [{ type: "text", text: "e".repeat(60_000) }], isError: true });
    expect(failed.isError).toBe(true);
  });
});

describe("the file", () => {
  it("is the scrubbed text, and the answer is built from the same scrubbed text", async () => {
    const home = tempDir("realm-tool-results-");
    const secret = "hunter2-the-masked-answer";
    const big = `${secret} ${"d".repeat(60_000)} ${secret}`;
    const answer = answerOf(await new ToolResultFiles({ home }).spill("s1", "codex", text(big), (t) => t.split(secret).join("[secret]")));
    const saved = readFileSync(savedIn(home, "s1")[0]!, "utf8");
    expect(saved).not.toContain(secret);
    expect(saved.startsWith("[secret] ")).toBe(true);
    expect(saved.endsWith(" [secret]")).toBe(true);
    expect(answer).not.toContain(secret);
  });

  it("is readable by its owner only, in a folder only its owner can enter", async () => {
    const home = tempDir("realm-tool-results-");
    await new ToolResultFiles({ home }).spill("s1", "codex", text("f".repeat(60_000)));
    expect(statSync(join(toolResultsRoot(home), "s1")).mode & 0o777).toBe(0o700);
    expect(statSync(savedIn(home, "s1")[0]!).mode & 0o777).toBe(0o600);
  });

  it("answers with the result as it is when the file cannot be written", async () => {
    const home = tempDir("realm-tool-results-");
    writeFileSync(toolResultsRoot(home), "a file where the folder should be");
    const big = text("g".repeat(60_000));
    expect(await new ToolResultFiles({ home }).spill("s1", "codex", big)).toBe(big);
  });

  // Realm's execution sandbox, as a session in a sandboxed space gets it: everything readable but
  // the protected files, and REALM_HOME is protected file by file, not as a whole.
  it.skipIf(process.platform !== "darwin")("is readable under Realm's execution sandbox, where realm.db is not", async () => {
    const root = tempDir("realm-tool-results-sbx-");
    const realmHome = join(root, "Realm");
    const checkout = join(root, "work");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(realmHome, { recursive: true });
    writeFileSync(join(realmHome, "realm.db"), "db");
    await new ToolResultFiles({ home: realmHome }).spill("s1", "codex", text("h".repeat(60_000)));
    const saved = savedIn(realmHome, "s1")[0]!;
    for (const posture of ["workspace-write", "read-only"] as const) {
      const policy = resolveExecutionSandboxPolicy({ prefs: { posture, network: false }, checkouts: [checkout], home: join(root, "home"), tmpDir: tmpdir(), realmHome });
      const run = (path: string) => {
        const cmd = sandboxCommand({ command: "/bin/cat", args: [path], policy });
        return execFileSync(cmd.command, cmd.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      };
      expect(run(saved)).toBe("h".repeat(60_000));
      expect(() => run(join(realmHome, "realm.db"))).toThrow();
    }
  });
});

describe("cleanup", () => {
  it("removes a session's saved results with the session", async () => {
    const home = tempDir("realm-tool-results-");
    const files = new ToolResultFiles({ home });
    await files.spill("s1", "codex", text("i".repeat(60_000)));
    await files.spill("s2", "codex", text("i".repeat(60_000)));
    await files.release("s1");
    expect(existsSync(join(toolResultsRoot(home), "s1"))).toBe(false);
    expect(savedIn(home, "s2")).toHaveLength(1);
  });

  it("sweeps results older than a week, and a session's folder once it is empty", async () => {
    const home = tempDir("realm-tool-results-");
    const now = Date.now();
    const files = new ToolResultFiles({ home, now: () => now });
    await files.spill("old", "codex", text("j".repeat(60_000)));
    await files.spill("mixed", "codex", text("k".repeat(60_000)));
    await files.spill("mixed", "codex", text("l".repeat(60_000)));
    const age = (path: string, days: number) => { const t = new Date(now - days * 24 * 60 * 60 * 1000); utimesSync(path, t, t); };
    age(savedIn(home, "old")[0]!, TOOL_RESULT_KEPT_DAYS + 1);
    const [stale, fresh] = savedIn(home, "mixed");
    age(stale!, TOOL_RESULT_KEPT_DAYS + 0.01);
    age(fresh!, TOOL_RESULT_KEPT_DAYS - 0.01);
    await files.sweep();
    expect(existsSync(join(toolResultsRoot(home), "old"))).toBe(false);
    expect(savedIn(home, "mixed")).toEqual([fresh]);
  });

  it("sweeps a home that has never saved anything", async () => {
    await expect(new ToolResultFiles({ home: tempDir("realm-tool-results-") }).sweep()).resolves.toBeUndefined();
  });
});

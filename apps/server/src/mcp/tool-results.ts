import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentKind } from "@realm/contracts";

/** Where a tool result too long for its engine is saved: `tool-results/<sessionId>/<callId>.txt`,
 *  beside `handoffs/` under Realm's home. */
export const toolResultsRoot = (home: string): string => join(home, "tool-results");

/** How long a saved result is kept. The answer that points at the file says so, so an agent resumed
 *  after a week that finds the file gone knows why. */
export const TOOL_RESULT_KEPT_DAYS = 7;
const KEPT_MS = TOOL_RESULT_KEPT_DAYS * 24 * 60 * 60 * 1000;

/**
 * How much of one tool result Codex hands its model: 40,000 bytes, the first 20,000 and the last
 * 20,000 with "…N tokens truncated…" between them. Its own limit reads 10,000 tokens, but it counts a
 * token as 4 bytes — MEASURED on codex-cli 0.169 (gpt-6-astra) with a 56,055-byte result of dense
 * JSON, where the 40,000 bytes it kept were ~19,000 real tokens. So the budget is in bytes.
 */
export const CODEX_TOOL_OUTPUT_BYTES = 40_000;

/**
 * The engines that cut a long tool result and keep no copy, with what they keep. Claude, Gemini and
 * opencode save an over-long result to a file of their own and tell the model where it is, so they
 * are not here: a second copy from Realm would be noise.
 */
const CUTS_WITHOUT_A_FILE: Partial<Record<AgentKind, { name: string; bytes: number }>> = { codex: { name: "Codex", bytes: CODEX_TOOL_OUTPUT_BYTES } };

/** Room for the JSON a result's text travels inside. */
const ENVELOPE_BYTES = 1_000;

/** How much of a saved result the answer starts with. Well inside every budget above, so the start
 *  of the result and the pointer after it arrive whole. */
export const PREVIEW_BYTES = 16_000;

/**
 * Bytes `text` takes as a JSON string, every quote and backslash escaped. The longest form a result's
 * text reaches the model in: in the live check Codex's model printed the whole result as JSON, and
 * dense JSON grew by a fifth.
 */
export const wireBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/** The longest start of `text` whose `wireBytes` is at most `budget`, never splitting a character. */
function startWithin(text: string, budget: number): string {
  let used = 2;
  let end = 0;
  for (const ch of text) {
    used += wireBytes(ch) - 2;
    if (used > budget) break;
    end += ch.length;
  }
  return text.slice(0, end);
}

const grouped = (n: number): string => n.toLocaleString("en-US");

/**
 * Saves a tool result too long for the engine reading it, for the engines that would otherwise cut
 * it and keep nothing (`CUTS_WITHOUT_A_FILE`). The agent is answered with the start of the result
 * and where the whole of it is.
 */
export class ToolResultFiles {
  constructor(private readonly d: { home: string; now?: () => number }) {}

  /**
   * `result` as it should reach `kind`: unchanged when it fits, or when it carries anything but text
   * (an image is not the agent's to read back from a file); otherwise saved, and answered with its
   * start and the file's path. `result` is what the agent would have been handed, compressed already,
   * and `scrub` is what a record Realm keeps of a call goes through (the session's masked answers), so
   * the file holds nothing the agent was not shown and no secret it was told in confidence.
   */
  async spill(sessionId: string, kind: AgentKind | undefined, result: CallToolResult, scrub: (text: string) => string = (t) => t): Promise<CallToolResult> {
    const engine = kind ? CUTS_WITHOUT_A_FILE[kind] : undefined;
    if (!engine || result.content.length === 0) return result;
    const kept = engine.bytes;
    const texts: string[] = [];
    for (const part of result.content) {
      if (part.type !== "text") return result;
      texts.push(part.text);
    }
    const text = scrub(texts.join("\n"));
    if (wireBytes(text) <= kept - ENVELOPE_BYTES) return result;

    const dir = join(toolResultsRoot(this.d.home), sessionId);
    const path = join(dir, `${randomUUID()}.txt`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
    } catch {
      // A full disk costs the agent the end of this result, as it did before there was a file.
      return result;
    }

    const size = grouped(Buffer.byteLength(text));
    const start = startWithin(text, PREVIEW_BYTES);
    const answer = [
      `[Realm: this result is ${size} bytes, more than ${engine.name} keeps of one (${grouped(kept)}), so it was saved whole to ${path} (${size} bytes, kept for ${TOOL_RESULT_KEPT_DAYS} days). Only its first ${grouped(Buffer.byteLength(start))} bytes are below. Read the file in pieces under ${grouped(kept)} bytes: a longer shell output is cut the same way.]`,
      "",
      start,
      "",
      `[Realm: cut here. The whole result is in ${path}]`,
    ].join("\n");
    return { content: [{ type: "text", text: answer }], isError: result.isError === true };
  }

  /** A deleted session's saved results go with it. */
  async release(sessionId: string): Promise<void> {
    await rm(join(toolResultsRoot(this.d.home), sessionId), { recursive: true, force: true });
  }

  /** Removes every saved result older than `TOOL_RESULT_KEPT_DAYS`, and a session's folder once it is
   *  empty. Run at boot. */
  async sweep(): Promise<void> {
    const root = toolResultsRoot(this.d.home);
    const cutoff = (this.d.now?.() ?? Date.now()) - KEPT_MS;
    let sessions: string[];
    try { sessions = await readdir(root); } catch { return; }
    for (const session of sessions) {
      const dir = join(root, session);
      let files: string[];
      try { files = await readdir(dir); } catch { continue; }
      for (const file of files) {
        const path = join(dir, file);
        try { if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true }); } catch { /* gone already */ }
      }
      await rmdir(dir).catch(() => { /* still holds a recent result */ });
    }
  }
}

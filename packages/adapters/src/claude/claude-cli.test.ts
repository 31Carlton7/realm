import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { ClaudeAdapter } from "./claude-adapter";

/* The adapter on the REAL Agent SDK, spawning a CLI that speaks the real protocol (fixtures/
   fake-claude-cli.mjs) — the path a person's session takes, where every other test here hands the
   adapter a fake `query`. What only this can show: that what the adapter sends mid-session reaches
   the CLI as a control request the CLI answers, and that the model list a real CLI gives is read. */
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");
let dir = "";
let journalFile = "";
let saved: string | undefined;

beforeAll(() => {
  dir = tempDir("realm-claude-cli-");
  journalFile = join(dir, "journal.jsonl");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/bash\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(bin, 0o755);
  saved = process.env.REALM_CLAUDE_BIN;
  process.env.REALM_CLAUDE_BIN = bin;
});
afterAll(() => { if (saved === undefined) delete process.env.REALM_CLAUDE_BIN; else process.env.REALM_CLAUDE_BIN = saved; });

const journal = (): { subtype: string; settings?: Record<string, unknown> }[] => {
  try { return readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const until = async (ok: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};
const texts = (evs: SessionEvent[]) => evs.flatMap((e) => (e.type === "assistant_text" ? [e.payload.text] : []));

describe("a Claude session on the real SDK", () => {
  it("moves the level and fast mode mid-session as control requests the CLI answers, and the next turn runs under them", async () => {
    const a = new ClaudeAdapter();
    const h = a.start({ cwd: dir, mcpServers: [], model: "claude-opus-5-5", env: { FAKE_CLAUDE_JOURNAL: journalFile } });
    const evs: SessionEvent[] = [];
    const pump = (async () => { for await (const e of h.events) evs.push(e); })();
    await h.send({ text: "first", attachments: [] });
    await until(() => texts(evs).length === 1);
    expect(texts(evs)[0]).toMatch(/^Ran on claude-opus-5-5: effort high, fast off\./);

    // Each of these resolves only once the CLI has answered it: a setOptions that never returned would
    // hang the RPC behind the picker's knob.
    await h.setOptions({ effort: "max" });
    await h.setOptions({ fastMode: true });
    expect(journal().filter((r) => r.subtype === "apply_flag_settings").map((r) => r.settings)).toEqual([{ effortLevel: "max" }, { fastMode: true }]);
    await h.send({ text: "second", attachments: [] });
    await until(() => texts(evs).length === 2);
    expect(texts(evs)[1]).toMatch(/effort max, fast on\./);

    // The real list's shape: Opus 5.5 only as `opus[1m]`, Haiku with no effort at all.
    await until(() => evs.some((e) => e.type === "init" && e.payload.effortModels !== undefined));
    const init = evs.filter((e) => e.type === "init").at(-1);
    expect(init?.type === "init" && init.payload.supportsFastMode).toBe(true);
    expect(init?.type === "init" && init.payload.effortModels?.["claude-opus-5-5"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(init?.type === "init" && init.payload.effortModels?.["claude-haiku-4-5"]).toEqual([]);
    await h.dispose(); await pump;
  }, 30_000);

  it("reads the model catalog off the handshake alone: no message is sent, and the CLI is let go", async () => {
    const own = join(dir, "probe-journal.jsonl");
    const prev = process.env.FAKE_CLAUDE_JOURNAL;
    process.env.FAKE_CLAUDE_JOURNAL = own;
    let row;
    try {
      row = await new ClaudeAdapter({ probe: async () => ({ available: true, version: "2.1.281 (Claude Code)", loggedIn: true, reason: null }) }).probe();
    } finally {
      if (prev === undefined) delete process.env.FAKE_CLAUDE_JOURNAL; else process.env.FAKE_CLAUDE_JOURNAL = prev;
    }
    const levels = ["low", "medium", "high", "xhigh", "max"];
    expect(row.models).toEqual([
      { id: "claude-fable-5-1", label: "claude-fable-5-1", isDefault: true, efforts: levels, fastMode: false },
      { id: "claude-opus-5-5[1m]", label: "Claude Opus (1M context)", efforts: levels, fastMode: true },
      { id: "claude-sonnet-5", label: "Claude Sonnet", efforts: levels, fastMode: true },
      { id: "claude-haiku-4-5", label: "Claude Haiku", efforts: [] },
    ]);
    const asked = readFileSync(own, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { subtype: string }).subtype);
    expect(asked).toEqual(["initialize"]);
  }, 30_000);

  it("starts a session asked for fast mode and a level before its first turn at both", async () => {
    // The first turn is the one a person switched them on for; the flag layer a live query writes
    // to does not exist until the process does, so these go in at start (`settings`, `--effort`).
    const a = new ClaudeAdapter();
    const h = a.start({ cwd: dir, mcpServers: [], model: "claude-opus-5-5", effort: "max", fastMode: true, env: { FAKE_CLAUDE_JOURNAL: journalFile } });
    const evs: SessionEvent[] = [];
    const pump = (async () => { for await (const e of h.events) evs.push(e); })();
    await h.send({ text: "first", attachments: [] });
    await until(() => texts(evs).length === 1);
    expect(texts(evs)[0]).toMatch(/^Ran on claude-opus-5-5: effort max, fast on\./);
    await h.dispose(); await pump;
  }, 30_000);
});

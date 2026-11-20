import { describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScript, type ProbeResult, type StartOptions } from "@realm/adapters";
import { tempDir } from "@realm/test-utils";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SummaryCancelled, SummaryUnavailable, quickChatSummariser, summaryTurn } from "./summary-turn";

class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(opts: StartOptions) { this.starts.push(opts); return super.start(opts); }
}

const turn = (script: FakeScript, o: { signal?: AbortSignal; timeoutMs?: number } = {}) => {
  const adapter = new RecordingFake({ script });
  const said = summaryTurn({ adapter, model: "quick", cwd: "/tmp/summary", prompt: "summarise this", signal: o.signal ?? new AbortController().signal, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  return { adapter, said };
};

describe("the summary turn", () => {
  it("answers with what the agent said", async () => {
    const { said } = turn([{ on: "summarise", emit: [{ kind: "text", text: "## Summary\nShort." }] }]);
    expect(await said).toBe("## Summary\nShort.");
  });

  it("joins an answer said in two messages", async () => {
    const { said } = turn([{ on: "summarise", emit: [{ kind: "text", text: "## Summary\nShort." }, { kind: "text", text: "## Decisions\nNone" }] }]);
    expect(await said).toBe("## Summary\nShort.\n\n## Decisions\nNone");
  });

  it("starts the agent with none of Realm's tools, in the folder it was given, keeping no session file", async () => {
    const { adapter, said } = turn([{ on: "summarise", emit: [{ kind: "text", text: "ok" }] }]);
    await said;
    expect(adapter.starts).toEqual([{ cwd: "/tmp/summary", model: "quick", permissionMode: "default", mcpServers: [], persistSession: false }]);
  });

  it("rejects with the agent's error when the turn fails", async () => {
    await expect(turn([{ on: "summarise", emit: [{ kind: "fail", message: "usage limit reached" }] }]).said).rejects.toThrow("usage limit reached");
    // An error the agent recovers from to idle is still a turn with no summary.
    await expect(turn([{ on: "summarise", emit: [{ kind: "text", text: "## Summary\nHalf" }, { kind: "throw", message: "stream cut" }] }]).said).rejects.toThrow("stream cut");
  });

  it("rejects as cancelled when stopped mid-answer, and before it starts", async () => {
    const abort = new AbortController();
    const { said } = turn([{ on: "summarise", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 40 }] }], { signal: abort.signal });
    setTimeout(() => abort.abort(), 60);
    await expect(said).rejects.toBeInstanceOf(SummaryCancelled);

    const { adapter, said: never } = turn([], { signal: abort.signal });
    await expect(never).rejects.toBeInstanceOf(SummaryCancelled);
    expect(adapter.starts).toEqual([]);
  });

  it("gives up on an agent that never answers", async () => {
    const { said } = turn([{ on: "summarise", emit: [{ kind: "tool", name: "Bash", input: {}, result: "", holdMs: 5_000 }] }], { timeoutMs: 80 });
    await expect(said).rejects.toThrow("the model took too long to answer");
  });

  it("refuses what the agent asks permission for", async () => {
    const { said } = turn([{ on: "summarise", emit: [
      { kind: "tool", name: "Bash", input: { command: "curl example.com" }, needsPermission: true, result: "ran" },
      { kind: "text", text: "## Summary\nShort." },
    ] }]);
    expect(await said).toBe("Okay, I won't run that.\n\n## Summary\nShort.");
  });
});

describe("the summary on the Quick chat model", () => {
  const probe = (kind: ProbeResult["kind"], o: Partial<ProbeResult> = {}): ProbeResult => ({ kind, available: true, version: "1", loggedIn: true, reason: null, ...o });
  const signal = new AbortController().signal;

  it("runs on the agent and model the setting names, and makes the folder", async () => {
    const claude = new RecordingFake({ script: [{ on: "summarise", emit: [{ kind: "text", text: "from claude" }] }] });
    const fake = new RecordingFake({ script: [] });
    const cwd = join(tempDir("realm-summary-"), "meeting-summary");
    const summarise = quickChatSummariser({ adapters: { claude, fake }, model: () => ({ agentKind: "claude", model: "claude-haiku-5-5" }), probes: () => [probe("claude")], cwd });
    expect(await summarise("summarise this", signal)).toBe("from claude");
    expect(claude.starts.map((s) => [s.cwd, s.model])).toEqual([[cwd, "claude-haiku-5-5"]]);
    expect(fake.starts).toEqual([]);
    expect(existsSync(cwd)).toBe(true);
  });

  it("is unavailable when the agent is signed out, not installed or not registered, and starts nothing", async () => {
    const claude = new RecordingFake({ script: [] });
    const cwd = join(tempDir("realm-summary-"), "meeting-summary");
    for (const probes of [[probe("claude", { loggedIn: false })], [probe("claude", { available: false, loggedIn: null })]]) {
      const summarise = quickChatSummariser({ adapters: { claude }, model: () => ({ agentKind: "claude", model: null }), probes: () => probes, cwd });
      await expect(summarise("summarise this", signal)).rejects.toBeInstanceOf(SummaryUnavailable);
    }
    const unregistered = quickChatSummariser({ adapters: {}, model: () => ({ agentKind: "claude", model: null }), probes: () => [], cwd });
    await expect(unregistered("summarise this", signal)).rejects.toBeInstanceOf(SummaryUnavailable);
    expect(claude.starts).toEqual([]);
  });

  it("gives an agent nobody has probed yet the turn", async () => {
    const claude = new RecordingFake({ script: [{ on: "summarise", emit: [{ kind: "text", text: "ok" }] }] });
    const summarise = quickChatSummariser({ adapters: { claude }, model: () => ({ agentKind: "claude", model: null }), probes: () => [], cwd: tempDir("realm-summary-") });
    expect(await summarise("summarise this", signal)).toBe("ok");
  });
});

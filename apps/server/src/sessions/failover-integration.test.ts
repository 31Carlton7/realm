import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * Failover through the real RPC surface, real database, real (scripted) adapters.
 *
 * The unit tests prove the decisions. This proves the WIRING those decisions depend on, which is the
 * half a mocked service cannot see: that `sessions.send` registers the turn, that an adapter's error
 * reaches the service at all, that the row's `agentKind` really moves, and — the one that would
 * silently rot — that the carried briefing is actually handed to the incoming adapter's `start`
 * rather than merely written to a settings row nobody reads.
 */
let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

/** Remembers every StartOptions it was handed — the seam that proves the briefing reaches a start. */
class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(o: StartOptions) { this.starts.push(o); return super.start(o); }
}

async function setup(script: { first: string; second: string }) {
  const home = tempDir("realm-failover-");
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  // Two adapters under two kinds. Both are FakeAdapters — what matters is that they are DIFFERENT
  // registry entries, because that is what a handoff moves between.
  const first = new RecordingFake({ script: [{ on: "go", emit: [{ kind: "throw", message: script.first }] }] });
  const second = new RecordingFake({ script: [{ on: "go", emit: [{ kind: "text", text: script.second }] }] });
  app = await createApp({ home, port: 0, adapters: { fake: first, codex: second } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  return { c, sp, first, second };
}

describe("failover over rpc", () => {
  it("hands a usage-limited turn to the next agent and finishes it there", async () => {
    const { c, sp, second } = await setup({ first: "Claude AI usage limit reached|123", second: "finished on the other one" });
    await c.call("failover.set", { spaceId: sp.id, policy: { retry: true, chain: ["codex"] } });
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;

    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.agentKind === "codex");

    // The turn was actually replayed, and on the second adapter.
    await waitFor(() => second.starts.length === 1);
    // The incoming adapter was NOT asked to resume the outgoing one's thread. That is the whole
    // reason `providerSessionId` is cleared, and the mutant (leave it set) is invisible everywhere
    // else — the new adapter would simply be handed a thread id from another vendor.
    expect(second.starts[0]!.resume ?? null).toBeNull();
    // And it was not asked for the old kind's model either.
    expect(second.starts[0]!.model).toBeNull();
    expect((await c.call("sessions.get", { id: session.id })).result.model).toBe(null);

    const events = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 500 })).result;
    const kinds = events.map((e: Any) => e.event.type);
    expect(kinds).toContain("handoff");
    const handoff = events.find((e: Any) => e.event.type === "handoff").event;
    expect(handoff.payload).toMatchObject({ from: "fake", to: "codex", reason: "usage_limit" });
    // Exactly ONE user_message: the user typed it once, and a transcript showing it twice is a
    // transcript lying about what was asked.
    expect(kinds.filter((k: string) => k === "user_message")).toHaveLength(1);
    await waitFor(async () => {
      const evs = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 500 })).result;
      return evs.some((e: Any) => e.event.type === "assistant_text" && e.event.payload.text === "finished on the other one");
    });
    c.close();
  });

  it("hands the incoming adapter the briefing, not just a settings row", async () => {
    // The mutant this kills: writing `failover.context:<id>` and never reading it back in
    // `ensureLive`. Everything else above would still pass, and the new agent would take over with
    // no idea what it had taken over.
    const { c, sp, second } = await setup({ first: "usage limit reached", second: "ok" });
    await c.call("failover.set", { spaceId: sp.id, policy: { retry: true, chain: ["codex"] } });
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go and do the thing" });
    await waitFor(() => second.starts.length === 1);
    const ctx = second.starts[0]!.systemContext ?? "";
    expect(ctx).toContain("Handed over mid-session");
    expect(ctx).toContain("go and do the thing");
    c.close();
  });

  it("leaves an ordinary failure exactly where it fell", async () => {
    // The common case, and the expensive mistake: an agent that failed because the code is wrong
    // fails identically on the next agent, and spending someone else's quota to prove that is worse
    // than stopping.
    const { c, sp, second } = await setup({ first: "TypeError: x is not a function", second: "ok" });
    await c.call("failover.set", { spaceId: sp.id, policy: { retry: true, chain: ["codex"] } });
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(async () => {
      const evs = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 })).result;
      return evs.some((e: Any) => e.event.type === "error");
    });
    expect((await c.call("sessions.get", { id: session.id })).result.agentKind).toBe("fake");
    expect(second.starts).toHaveLength(0);
    c.close();
  });

  it("does nothing at all with the default policy, however the turn dies", async () => {
    const { c, sp, second } = await setup({ first: "usage limit reached", second: "ok" });
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    expect((await c.call("failover.get", { spaceId: sp.id })).result).toEqual({ retry: true, chain: [] });
    await c.call("sessions.send", { id: session.id, text: "go" });
    // The note that says a chain is what would have helped — the one thing a user who just lost an
    // hour to a usage limit could not otherwise learn.
    await waitFor(async () => {
      const evs = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 })).result;
      return evs.some((e: Any) => e.event.type === "error" && String(e.event.payload.message).includes("no fallback agent"));
    });
    expect((await c.call("sessions.get", { id: session.id })).result.agentKind).toBe("fake");
    expect(second.starts).toHaveLength(0);
    c.close();
  });
});

describe("a document the agent writes", () => {
  it("opens in the documents pane, rather than arriving as a path in grey text", async () => {
    /* The gap behind "I asked for a doc and the docs pane never opened": Realm knew about the file
       the moment the tool call landed and did nothing with it. `documents.openRequested` is the
       broadcast the renderer already lands quietly beside the session — this is what emits it. */
    const home = tempDir("realm-writedoc-");
    const fake = new RecordingFake({ script: [{ on: "go", emit: [
      { kind: "tool", name: "Write", input: { file_path: "notes.md" }, result: "ok" },
    ] }] });
    app = await createApp({ home, port: 0, adapters: { fake } });
    const c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "W" })).result;
    const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
    // The file has to exist: `openPath` refuses a tab on nothing, because an empty editor that
    // cannot save is a worse outcome than no tab.
    const { documentsId } = (await c.call("documents.create", { spaceId: sp.id })).result;
    await c.call("documents.write", { documentsId, path: "notes.md", text: "# n", baseHash: null });

    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => c.events.some((e: Any) => e.event === "documents.openRequested"));
    const opened = c.events.find((e: Any) => e.event === "documents.openRequested");
    expect(opened.payload.path).toBe("notes.md");
    c.close();
  });

  it("stays out of the way for an edit, and for a file the pane cannot render", async () => {
    // A refactor across twenty files must not open twenty tabs, and a `.ts` does not belong behind
    // a rich-text editor.
    const home = tempDir("realm-writedoc2-");
    const fake = new RecordingFake({ script: [{ on: "go", emit: [
      { kind: "tool", name: "Edit", input: { file_path: "notes.md" }, result: "ok" },
      { kind: "tool", name: "Write", input: { file_path: "index.ts" }, result: "ok" },
    ] }] });
    app = await createApp({ home, port: 0, adapters: { fake } });
    const c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "W" })).result;
    const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "idle");
    expect(c.events.some((e: Any) => e.event === "documents.openRequested")).toBe(false);
    c.close();
  });
});

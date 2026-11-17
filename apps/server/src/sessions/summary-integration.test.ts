import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle } from "@realm/adapters";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A Claude engine that runs a command each turn and settles, and reports `ended` when it is stopped. */
class WorkingAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("status", { status: "idle" }));
    let n = 0;
    return {
      events,
      send: async () => {
        n += 1;
        events.push(sessionEvent("status", { status: "running" }));
        events.push(sessionEvent("tool_call", { toolUseId: `t${n}`, name: "Bash", input: { command: "pnpm test" }, parentToolUseId: null }));
        events.push(sessionEvent("tool_result", { toolUseId: `t${n}`, content: "ok", isError: false }));
        events.push(sessionEvent("assistant_text", { messageId: `m${n}`, text: `ran the tests ${n}` }));
        events.push(sessionEvent("status", { status: "idle" }));
      },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.push(sessionEvent("status", { status: "ended" })); events.close(); },
    };
  }
}

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call };
}

/** A real app with a fake recap writer handed in through the seam the billed one uses. */
async function boot() {
  const home = tempDir("realm-recap-int-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const summaryGenerator = vi.fn(async () => ({ summary: "You ran the tests and they passed.", hint: "Ship it" as string | null }));
  app = await createApp({ home, port: 0, adapters: { claude: new WorkingAdapter() }, summaryGenerator });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "Work" })).result;
  const { session, itemId } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "claude" })).result as { session: { id: string }; itemId: string };
  const say = async (text: string) => {
    await c.call("sessions.send", { id: session.id, text });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "idle");
  };
  const summaries = async () => ((await c.call("sessions.events", { id: session.id, afterSeq: 0 })).result as Any[])
    .filter((e) => e.event.type === "summary");
  return { c, session, itemId, say, summaryGenerator, summaries };
}

describe("when a session is recapped, end to end", () => {
  it("not when a turn settles mid-session", async () => {
    const t = await boot();
    await t.say("run the tests");
    await t.say("and again");
    await new Promise((r) => setTimeout(r, 200));
    expect(t.summaryGenerator).not.toHaveBeenCalled();
  });

  it("when the session is put away", async () => {
    const t = await boot();
    await t.say("run the tests");
    await t.c.call("items.update", { id: t.itemId, archived: true });
    await waitFor(async () => (await t.summaries()).length === 1);
    expect(t.summaryGenerator).toHaveBeenCalledTimes(1);
  });

  it("when its engine stops", async () => {
    const t = await boot();
    await t.say("run the tests");
    await t.c.call("daemon.stopAgents", {});
    await waitFor(async () => (await t.summaries()).length === 1);
    expect(t.summaryGenerator).toHaveBeenCalledTimes(1);
  });

  it("not when the session is deleted", async () => {
    const t = await boot();
    await t.say("run the tests");
    await t.c.call("sessions.delete", { id: t.session.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(t.summaryGenerator).not.toHaveBeenCalled();
  });
});

describe("a recap written after the session was read", () => {
  const marks = async (t: Awaited<ReturnType<typeof boot>>) => {
    const s = (await t.c.call("sessions.get", { id: t.session.id })).result as { seenSeq: number; lastEventSeq: number };
    return { seen: s.seenSeq, last: s.lastEventSeq };
  };

  it("leaves it read: no unread mark for a recap and a hint", async () => {
    const t = await boot();
    await t.say("run the tests");
    await t.c.call("sessions.markSeen", { id: t.session.id, seq: (await marks(t)).last });
    const before = await marks(t);
    await t.c.call("items.update", { id: t.itemId, archived: true });
    await waitFor(async () => (await t.summaries()).length === 1);
    await waitFor(async () => (await marks(t)).last > before.last + 1);
    const after = await marks(t);
    expect(after.seen).toBe(after.last);
  });

  it("leaves a session read only partway unread, and one never opened at 0", async () => {
    const partway = await boot();
    await partway.say("run the tests");
    await partway.c.call("sessions.markSeen", { id: partway.session.id, seq: (await marks(partway)).last - 1 });
    const before = await marks(partway);
    await partway.c.call("items.update", { id: partway.itemId, archived: true });
    await waitFor(async () => (await partway.summaries()).length === 1);
    expect((await marks(partway)).seen).toBe(before.seen);
    await app.close();

    const never = await boot();
    await never.say("run the tests");
    await never.c.call("items.update", { id: never.itemId, archived: true });
    await waitFor(async () => (await never.summaries()).length === 1);
    expect((await marks(never)).seen).toBe(0);
  });
});

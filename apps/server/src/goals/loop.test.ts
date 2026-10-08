import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { MID_TURN_MODE_KEY } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/* Goal mode through the whole server: the scripted agent's turns go through the real adapter pump,
   the session service's settle and the real gateway, so what is checked here is what the session
   service tells the loop about each turn — the part `service.test.ts` hands in by hand. */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = async (method: string, params: unknown): Promise<Any> => {
    const id = String(++n);
    const m = await new Promise<Any>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    if (!m.ok) throw new Error(`${method}: ${m.error?.message}`);
    return m.result;
  };
  const sessionEvents = (sessionId: string, type: string) => events
    .filter((e) => e.event === "session.event" && e.payload.sessionId === sessionId && e.payload.event.type === type)
    .map((e) => e.payload.event.payload);
  return { call, sessionEvents, close: () => ws.close() };
}

async function boot(script: FakeScript) {
  app = await createApp({ home: tempDir("realm-goal-loop-"), port: 0, adapters: { fake: new FakeAdapter({ script }) } });
  const c = await client(app.port);
  const p = await c.call("profiles.create", { name: "W" });
  const sp = await c.call("spaces.create", { profileId: p.id, name: "S" });
  const { session } = await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" });
  const goal = async () => (await c.call("goals.get", { sessionId: session.id })).goal;
  const continuations = () => c.sessionEvents(session.id, "user_message").filter((m: Any) => m.goal === "continuation").length;
  return { c, sp, id: session.id as string, goal, continuations };
}

describe("a goal's turns, as the session service reports them", () => {
  it("stops after three continuations that did nothing", async () => {
    /* The scripted agent echoes: no tool calls, a second's work. THE mutant is a settle that does not
       hand the turn over (`turn` left off `onSettled`) — the loop then has nothing to count, and the
       goal continues itself until the test times out. */
    const { c, id, goal, continuations } = await boot([]);
    await c.call("goals.start", { sessionId: id, objective: "say hello", tokenBudget: null });
    await waitFor(async () => (await goal()).status !== "active", { timeout: 10_000 });
    expect(await goal()).toMatchObject({ status: "blocked", note: "3 turns in a row made no progress, so Realm stopped continuing this goal." });
    await new Promise((r) => setTimeout(r, 300));
    expect(continuations()).toBe(3);
  });

  it("finishes on the agent's GOAL COMPLETE: line", async () => {
    const { c, id, goal, continuations } = await boot([
      { on: "Continue working towards", emit: [{ kind: "text", text: "Checked it.\nGOAL COMPLETE: The greeting is written." }] },
    ]);
    await c.call("goals.start", { sessionId: id, objective: "write the greeting", tokenBudget: null });
    await waitFor(async () => (await goal()).status === "complete", { timeout: 10_000 });
    expect((await goal()).note).toBe("The greeting is written.");
    await new Promise((r) => setTimeout(r, 300));
    expect(continuations()).toBe(1);
  });

  it("is closed by update_goal on a goal started after the agent connected", async () => {
    /* The 2026-10-07 session: the agent connected and listed its tools before `/goal` was typed. The
       tool is called under the provider's real name, through the real gateway. */
    const { c, id, goal, continuations } = await boot([
      { on: "look around", emit: [{ kind: "call", tool: "realm-goal__goal_status", input: {} }] },
      { on: "Continue working towards", emit: [
        { kind: "call", tool: "realm-goal__update_goal", input: { status: "complete", note: "All three files exist." } },
        { kind: "text", text: "Marked it done." },
      ] },
    ]);
    await c.call("sessions.send", { id, text: "look around" });
    await waitFor(() => c.sessionEvents(id, "tool_result").length === 1);
    // Without a goal the tool answers, and refuses.
    expect(c.sessionEvents(id, "tool_result")[0]).toMatchObject({ isError: true });
    await waitFor(async () => (await c.call("sessions.get", { id })).status === "idle");
    await c.call("goals.start", { sessionId: id, objective: "create three files", tokenBudget: null });
    await waitFor(async () => (await goal()).status === "complete", { timeout: 10_000 });
    expect((await goal()).note).toBe("All three files exist.");
    await new Promise((r) => setTimeout(r, 300));
    expect(continuations()).toBe(1);
  });

  it("throws away a continuation still queued when the goal is marked done, and keeps what the user typed", async () => {
    const { c, id, goal } = await boot([
      { on: "hold", emit: [{ kind: "tool", name: "Bash", input: { command: "sleep" }, needsPermission: true, result: "x" }] },
    ]);
    await c.call("settings.set", { key: MID_TURN_MODE_KEY, value: "queue" });
    await c.call("goals.start", { sessionId: id, objective: "hold the line", tokenBudget: null });
    await waitFor(() => c.sessionEvents(id, "permission_request").length === 1);
    await c.call("goals.set", { sessionId: id, status: "paused", note: null });
    // The turn is still running, so the resume's continuation and the user's next message both queue.
    await c.call("goals.resume", { sessionId: id });
    await c.call("sessions.send", { id, text: "and then this" });
    expect((await c.call("sessions.queued", { id })).queued.length).toBe(2);
    await c.call("goals.set", { sessionId: id, status: "complete", note: "Marked done by you." });
    // THE mutant keeps the queued continuation, which would go out after the goal was done.
    expect((await c.call("sessions.queued", { id })).queued.map((q: Any) => q.text)).toEqual(["and then this"]);
    expect((await goal()).status).toBe("complete");
  });
});

import { describe, expect, it, afterEach } from "vitest";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { RUN_BLOCK_SENTINEL } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * The runs RPC surface over the REAL socket. `service.test.ts` drives `RunService` directly, which
 * proves the state machine but never touches the layer this exercises: the zod params/result schemas
 * in `contracts/rpc.ts`, the `registerMethods` wiring, and the `runs.changed` broadcast. A method
 * whose declared result disagrees with what the service returns fails here and nowhere else.
 */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SCRIPT: FakeScript = [
  { on: "supervising this run replied", emit: [{ kind: "text", text: "FINAL: used MLA" }] },
  { on: "You are an unattended run.", emit: [{ kind: "text", text: `${RUN_BLOCK_SENTINEL} which citation style?` }] },
];

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

async function boot(script: FakeScript = SCRIPT) {
  const home = tempDir("realm-runs-rpc-");
  const fake = new FakeAdapter({ script, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  return { c: await client(app.port), spaceId: space.id };
}

describe("the runs RPC surface", () => {
  it("creates, lists, reads and answers a run — and broadcasts every move", async () => {
    const { c, spaceId } = await boot();
    const created = await c.call("runs.create", { spaceId, goal: "Draft the week 3 essay" });
    expect(created.ok).toBe(true);
    expect(created.result.created).toBe(true);
    const id = created.result.run.id as string;
    // Defaults come off the schema, not the caller: one attempt, no dedupe key, no deadline.
    expect(created.result.run).toMatchObject({ spaceId, state: "queued", attempt: 0, maxAttempts: 1, dedupeKey: null, deadlineAt: null });

    await waitFor(async () => (await c.call("runs.get", { id })).result?.run.state === "blocked");
    const detail = (await c.call("runs.get", { id })).result;
    expect(detail.run.result).toContain("citation style");
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ n: 1, outcome: "blocked" });

    const listed = await c.call("runs.list", { spaceId });
    expect(listed.result.runs.map((r: Any) => r.id)).toEqual([id]);
    expect(listed.result.nextCursor).toBeNull();
    // The state filter is honoured over the wire, not just in the store.
    expect((await c.call("runs.list", { spaceId, states: ["succeeded"] })).result.runs).toEqual([]);

    const approved = await c.call("runs.approve", { id, approved: true, note: "Use MLA." });
    expect(approved.ok).toBe(true);
    await waitFor(async () => (await c.call("runs.get", { id })).result?.run.state === "succeeded");
    expect((await c.call("runs.get", { id })).result.run.result).toBe("FINAL: used MLA");

    // Every transition reached the client as a `runs.changed` carrying the fresh row.
    const changes = c.events.filter((e) => e.event === "runs.changed");
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.every((e) => e.payload.spaceId === spaceId)).toBe(true);
    expect(changes.map((e) => e.payload.run.state)).toContain("blocked");
    expect(changes.map((e) => e.payload.run.state)).toContain("succeeded");
    c.close();
  });

  it("returns the existing run for a repeated dedupe key rather than a second one", async () => {
    const { c, spaceId } = await boot();
    const first = await c.call("runs.create", { spaceId, goal: "weekly", dedupeKey: "cs101" });
    const second = await c.call("runs.create", { spaceId, goal: "weekly", dedupeKey: "cs101" });
    expect(second.result.created).toBe(false);
    expect(second.result.run.id).toBe(first.result.run.id);
    expect((await c.call("runs.list", { spaceId })).result.runs).toHaveLength(1);
    c.close();
  });

  it("refuses bypassPermissions at the schema edge — an unattended run cannot even ask", async () => {
    const { c, spaceId } = await boot();
    const r = await c.call("runs.create", { spaceId, goal: "go", constraints: { permissionMode: "bypassPermissions" } });
    expect(r.ok).toBe(false);
    // And nothing was created by the refused call.
    expect((await c.call("runs.list", { spaceId })).result.runs).toEqual([]);
    c.close();
  });

  it("reports a missing run as null rather than an error", async () => {
    const { c } = await boot();
    const r = await c.call("runs.get", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(r.ok).toBe(true);
    expect(r.result).toBeNull();
    c.close();
  });

  it("refuses approving a run that is not blocked, with a code the UI can read", async () => {
    const { c, spaceId } = await boot([{ on: "You are an unattended run.", emit: [{ kind: "text", text: "FINAL: done" }] }]);
    const id = (await c.call("runs.create", { spaceId, goal: "go" })).result.run.id as string;
    await waitFor(async () => (await c.call("runs.get", { id })).result?.run.state === "succeeded");
    const r = await c.call("runs.approve", { id, approved: true, note: null });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("RUN_NOT_BLOCKED");
    c.close();
  });
});

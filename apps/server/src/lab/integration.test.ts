import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { QUIET_HOLD_MS } from "./update-window";

/**
 * The update window over the real socket, against a real team: a role's run that is working when the
 * window opens is waited for, a run woken while it is open stays queued, main is told to install once
 * nothing runs, and the held run starts the moment the app comes back on the new version.
 */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SCRIPT: FakeScript = [
  { on: "take your time", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 60 }] },
  { on: "quick one", emit: [{ kind: "text", text: "done" }] },
];

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 8000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const must = async (method: string, params: unknown) => { const r = await call(method, params); if (!r.ok) throw new Error(`${method}: ${r.error?.message}`); return r.result; };
  return { call, must, events, close: () => ws.close() };
}

describe("the lab's update window over the wire", () => {
  it("waits for a running role run, holds a new one, installs, and lets it go on the new version", async () => {
    const home = tempDir("realm-lab-");
    let now = Date.now();
    const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
    app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" },
      lab: { probe: async () => [], hostName: async () => "lab-mini.local", now: () => now } });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
    const c = await client(app.port);
    await c.must("team.make", { spaceId: space.id, templates: [] });
    const role = await c.must("team.roleCreate", { spaceId: space.id, name: "Content Producer", brief: "Make slides.", realmite: { seed: "cp" }, agentKind: "fake" });
    const runsOf = async () => (await c.must("team.roleRuns", { id: role.id, limit: 20 })) as Any[];

    await c.must("lab.setEnabled", { enabled: true });
    // A run is working when the update arrives and the window is opened.
    const first = await c.must("team.roleRun", { id: role.id, message: "take your time" });
    await waitFor(async () => (await runsOf()).some((r) => r.id === first.id && r.state === "running"), { timeout: 8000 });
    await c.must("lab.updateReady", { version: "9.9.9", from: "2.0.3" });
    const opened = await c.must("lab.updateNow", {});
    expect(opened.update).toMatchObject({ kind: "draining", running: 1 });

    // Woken while the window is open: it stays queued.
    const second = await c.must("team.roleRun", { id: role.id, message: "quick one" });
    await waitFor(async () => (await runsOf()).find((r) => r.id === first.id)?.state === "succeeded", { timeout: 8000 });
    app.lab.tick();
    expect((await runsOf()).find((r) => r.id === second.id)?.state).toBe("queued");
    expect(c.events.some((e) => e.event === "lab.install")).toBe(false);

    // Quiet, held for long enough: main is told to install.
    app.lab.tick();
    now += QUIET_HOLD_MS;
    app.lab.tick();
    await waitFor(() => c.events.some((e) => e.event === "lab.install" && e.payload.version === "9.9.9"), { timeout: 4000 });
    expect((await c.must("lab.status", {})).update).toMatchObject({ kind: "installing", leftRunning: 0 });
    expect((await runsOf()).find((r) => r.id === second.id)?.state).toBe("queued");

    // The relaunched app says its version: the held run starts and finishes.
    now += 60_000;
    expect((await c.must("lab.appVersion", { version: "9.9.9" })).update).toMatchObject({ kind: "resumed", applied: true });
    await waitFor(async () => (await runsOf()).find((r) => r.id === second.id)?.state === "succeeded", { timeout: 8000 });
    c.close();
  });

  it("registers a device for a team over the wire", async () => {
    const home = tempDir("realm-lab-");
    app = await createApp({ home, port: 0, lab: { probe: async () => [], hostName: async () => null } });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
    const c = await client(app.port);
    const out = await c.must("lab.deviceAdd", { kind: "iphone", name: "Lab iPhone 1", spaceId: space.id, accounts: [{ service: "TikTok", handle: "@versed.nathan" }] });
    expect(out.devices[0]).toMatchObject({ name: "Lab iPhone 1", spaceName: "Versed", connected: false, lastSeenAt: null });
    const refused = await c.call("lab.deviceAdd", { kind: "iphone", name: "Too many", accounts: [1, 2, 3, 4].map((n) => ({ service: "TikTok", handle: `@c${n}` })) });
    expect(refused.ok).toBe(false);
    expect(refused.error.message).toMatch(/at most 3 accounts/);
    c.close();
  });
});

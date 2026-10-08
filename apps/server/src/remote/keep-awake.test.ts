import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { POWER_PREVENT_SLEEP_KEY } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { HeadlessKeepAwake, type HoldAwake } from "./keep-awake";

/** Stand-ins for caffeinate: each records whether it was let go, and can die on its own. */
function holders() {
  const made: Array<{ killed: boolean; die(): void }> = [];
  const hold: HoldAwake = () => {
    const events = new EventEmitter();
    const h = { killed: false, kill: () => { h.killed = true; }, once: (e: "exit" | "error", l: () => void) => events.once(e, l), die: () => events.emit("exit") };
    made.push(h);
    return h;
  };
  return { hold, made, live: () => made.filter((h) => !h.killed).length };
}

function guard(start: Partial<{ attached: boolean; wanted: boolean; working: number; needsYou: number; phones: number }> = {}) {
  const s = { attached: false, wanted: true, working: 1, needsYou: 0, phones: 0, ...start };
  const h = holders();
  const g = new HeadlessKeepAwake({
    attached: () => s.attached, wanted: () => s.wanted, counts: () => ({ working: s.working, needsYou: s.needsYou }), phones: () => s.phones, hold: h.hold,
  });
  return { g, s, ...h };
}

describe("HeadlessKeepAwake", () => {
  it("holds while a session works with no app attached and the preference on", () => {
    const { g, live } = guard();
    g.refresh();
    expect(live()).toBe(1);
    expect(g.holding).toBe(true);
  });

  it("holds once however often it is asked", () => {
    const { g, made } = guard();
    g.refresh();
    g.refresh();
    expect(made).toHaveLength(1);
  });

  it("leaves it to the app while the app is attached, and takes over when it goes", () => {
    const { g, s, live } = guard({ attached: true });
    g.refresh();
    expect(live()).toBe(0);
    s.attached = false;
    g.refresh();
    expect(live()).toBe(1);
    s.attached = true;
    g.refresh();
    expect(live()).toBe(0);
  });

  it("never holds with the preference off", () => {
    const { g, live } = guard({ wanted: false });
    g.refresh();
    expect(live()).toBe(0);
  });

  it("lets go the moment the work ends", () => {
    const { g, s, live } = guard();
    g.refresh();
    s.working = 0;
    g.refresh();
    expect(live()).toBe(0);
    expect(g.holding).toBe(false);
  });

  it("holds for a session waiting on its owner only with a phone paired", () => {
    const { g, s, live } = guard({ working: 0, needsYou: 1, phones: 0 });
    g.refresh();
    expect(live()).toBe(0);
    s.phones = 1;
    g.refresh();
    expect(live()).toBe(1);
  });

  it("holds again when caffeinate died on its own", () => {
    const { g, made, live } = guard();
    g.refresh();
    made[0]!.die();
    expect(g.holding).toBe(false);
    g.refresh();
    expect(made).toHaveLength(2);
    expect(live()).toBe(2); // the first was never killed by us: it died
  });

  it("lets go on close", () => {
    const { g, live } = guard();
    g.refresh();
    g.close();
    expect(live()).toBe(0);
  });

  it("holds nothing where there is no caffeinate", () => {
    const g = new HeadlessKeepAwake({ attached: () => false, wanted: () => true, counts: () => ({ working: 1, needsYou: 0 }), phones: () => 0, hold: null });
    g.refresh();
    expect(g.holding).toBe(false);
  });

  it.runIf(process.platform === "darwin")("holds with a real caffeinate tied to this process, and ends it on close", async () => {
    const g = new HeadlessKeepAwake({ attached: () => false, wanted: () => true, counts: () => ({ working: 1, needsYou: 0 }), phones: () => 0 });
    const running = () => execFileSync("/bin/ps", ["-Ao", "args"], { encoding: "utf8" }).split("\n").some((l) => l.trim() === `/usr/bin/caffeinate -i -w ${process.pid}`);
    g.refresh();
    try {
      await waitFor(running);
      expect(g.holding).toBe(true);
    } finally {
      g.close();
    }
    await waitFor(() => !running());
  });
});

// ── Wired into the app ─────────────────────────────────────────────────────────────────────────

let app: App | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: { result?: unknown; error?: unknown }) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (method: string, params: unknown) => new Promise<any>((res) => {
    const id = String(++n);
    pending.set(id, (m) => res(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

describe("the server's own keep-awake, in the app", () => {
  it("holds while a turn runs with no app attached, lets go while one attaches, and when the turn ends", async () => {
    const { hold, live } = holders();
    app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { fake: new FakeAdapter({ script: [], delayMs: 3_000 }) }, remote: { holdAwake: hold } });
    const c = await client(app.port);
    await c.call("settings.set", { key: POWER_PREVENT_SLEEP_KEY, value: true });
    const profile = await c.call("profiles.create", { name: "W" });
    const space = await c.call("spaces.create", { profileId: profile.id, name: "S" });
    const { session } = await c.call("sessions.create", { spaceId: space.id, agentKind: "fake" });

    await c.call("sessions.send", { id: session.id, text: "work" });
    await waitFor(() => live() === 1);

    // The app attaches: it holds the Mac itself, so the server lets go, and takes over when it leaves.
    const main = await client(app.port);
    // Each hand-over is the attach or detach itself, well inside the 3 s turn.
    await main.call("browserHost.register", { hasWindow: true });
    await waitFor(() => live() === 0, { timeout: 500 });
    main.close();
    await waitFor(() => live() === 1, { timeout: 500 });

    // The turn ends, and nothing keeps the Mac awake for it any more.
    await waitFor(() => live() === 0, { timeout: 10_000 });
    c.close();
  });
});

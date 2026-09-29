import { describe, expect, it, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { MODEL_FAST_SUPPORT_KEY, sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * What the harness says about fast mode, remembered for the next session on the same model.
 *
 * End to end because the whole point is a seam: the fact arrives on one session's `init`, and it is
 * wanted by a DIFFERENT session that has not started — so it has to leave the event stream and land
 * somewhere a prompter can read before anything runs. Pinned here is that it lands, under the key a
 * prompter can compute from a session row alone.
 */

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Answers every handshake with `answer` — `undefined` is a harness that says nothing. */
class AnsweringAdapter implements AgentAdapter {
  answer: boolean | undefined = true;
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: `prov_${this.starts.length}`, model: "resolved-by-the-harness", tools: [], cwd: opts.cwd,
      ...(this.answer === undefined ? {} : { supportsFastMode: this.answer }) }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => { events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
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
  return { call, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-fast-int-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const claude = new AnsweringAdapter("claude");
  app = await createApp({ home, port: 0, adapters: { claude }, claudeDir: join(home, "claude-home") });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: p.id, name: "A" })).result;
  const remembered = async () => (await c.call("settings.get", { key: MODEL_FAST_SUPPORT_KEY })).result.value as Record<string, boolean> | null;
  /** Starts a session's adapter the way anything real does — on the first send — and waits for its handshake. */
  const run = async (model: string | null) => {
    const before = claude.starts.length;
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "claude", model })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => claude.starts.length === before + 1);
  };
  return { c, claude, remembered, run };
}

describe("fast-mode support, remembered past the session that heard it", () => {
  it("is filed under the model the session ASKED for, not the id the harness resolved it to", async () => {
    const { c, remembered, run } = await boot();
    await run("claude-opus-5-5");
    // THE MUTANT: key by `init.model`. A prompter holding a session that has not started knows only
    // its row, so an answer filed under the resolved id could never be found by the one reader.
    await waitFor(async () => (await remembered())?.["claude:claude-opus-5-5"] === true);
    expect(await remembered()).toEqual({ "claude:claude-opus-5-5": true });
    c.close();
  });

  it("files a session on the harness's default under the default's own entry", async () => {
    const { c, remembered, run } = await boot();
    await run(null);
    await waitFor(async () => (await remembered())?.["claude:"] === true);
    c.close();
  });

  it("takes a later `no` over an earlier `yes`, and leaves every other model's answer alone", async () => {
    const { c, claude, remembered, run } = await boot();
    await run("claude-opus-5-5");
    await run("claude-sonnet-5");
    await waitFor(async () => Object.keys((await remembered()) ?? {}).length === 2);
    claude.answer = false;
    await run("claude-opus-5-5");
    await waitFor(async () => (await remembered())?.["claude:claude-opus-5-5"] === false);
    expect(await remembered()).toEqual({ "claude:claude-opus-5-5": false, "claude:claude-sonnet-5": true });
    c.close();
  });

  it("writes nothing for a handshake that says nothing — silence is not a `no`", async () => {
    const { c, claude, remembered, run } = await boot();
    await run("claude-opus-5-5");
    await waitFor(async () => (await remembered())?.["claude:claude-opus-5-5"] === true);
    claude.answer = undefined;
    await run("claude-opus-5-5");
    // A beat for the handshake to have been handled — the session's status settles after it.
    await new Promise((r) => setTimeout(r, 50));
    expect(await remembered()).toEqual({ "claude:claude-opus-5-5": true });
    c.close();
  });
});

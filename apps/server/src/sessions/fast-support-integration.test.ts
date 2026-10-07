import { describe, expect, it, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { MODEL_EFFORTS_KEY, MODEL_FAST_SUPPORT_KEY, sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
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
  /** The harness's answer for its whole list (`fastModeModels`); `undefined` lists nothing. */
  models: Record<string, boolean> | undefined = undefined;
  /** The harness's levels per listed model (`effortModels`); `undefined` lists nothing. */
  levels: Record<string, string[]> | undefined = undefined;
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: `prov_${this.starts.length}`, model: "resolved-by-the-harness", tools: [], cwd: opts.cwd,
      ...(this.answer === undefined ? {} : { supportsFastMode: this.answer }),
      ...(this.models === undefined ? {} : { fastModeModels: this.models }),
      ...(this.levels === undefined ? {} : { effortModels: this.levels }) }));
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
  const levels = async () => (await c.call("settings.get", { key: MODEL_EFFORTS_KEY })).result.value as Record<string, string[]> | null;
  /** Starts a session's adapter the way anything real does — on the first send — and waits for its handshake. */
  const run = async (model: string | null) => {
    const before = claude.starts.length;
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "claude", model })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => claude.starts.length === before + 1);
  };
  return { c, claude, remembered, levels, run };
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

  it("files the harness's answer for every model it listed, so a model no session has run is known too", async () => {
    // THE owner's case: a new session on a model nothing had run yet had no answer to read, so its
    // prompter offered no switch until after the first message — too late for that message.
    const { c, claude, remembered, run } = await boot();
    claude.models = { "": false, "claude-fable-5-1": false, "claude-opus-5-5": true };
    await run("claude-sonnet-5");
    await waitFor(async () => Object.keys((await remembered()) ?? {}).length === 4);
    // The listed ids under their own keys ("" is the harness default), and the session's own answer
    // under the model it ASKED for — that one written last, as the more specific of the two.
    expect(await remembered()).toEqual({
      "claude:": false, "claude:claude-fable-5-1": false, "claude:claude-opus-5-5": true, "claude:claude-sonnet-5": true,
    });
    c.close();
  });

  it("lets the session's own answer stand over the list's for the model it asked for", async () => {
    const { c, claude, remembered, run } = await boot();
    claude.answer = false;
    claude.models = { "claude-opus-5-5": true };
    await run("claude-opus-5-5");
    await waitFor(async () => (await remembered())?.["claude:claude-opus-5-5"] !== undefined);
    expect(await remembered()).toEqual({ "claude:claude-opus-5-5": false });
    c.close();
  });

  it("files each listed model's reasoning levels beside its fast-mode answer", async () => {
    // The effort control's counterpart of the row above: Claude's levels are per model and only its
    // CLI knows them, so one session's handshake is what the next session's control offers.
    const { c, claude, levels, run } = await boot();
    claude.levels = { "": ["low", "medium", "high"], "claude-haiku-4-5": [] };
    await run("claude-opus-5-5");
    await waitFor(async () => Object.keys((await levels()) ?? {}).length === 2);
    expect(await levels()).toEqual({ "claude:": ["low", "medium", "high"], "claude:claude-haiku-4-5": [] });
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

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type CleanedDictation } from "@realm/adapters";
import { VOICE_PREFS_KEY, type DictationCleanResult as CleanResult } from "@realm/contracts";
import { createApp, type App } from "../app";

let app: App;
afterEach(async () => { await app?.close(); });

async function boot(cleanup: (raw: string) => Promise<CleanedDictation>) {
  app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { fake: new FakeAdapter({ script: [] }) }, dictationCleanup: cleanup });
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app.port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: { result?: unknown; error?: { message?: string } }) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const send = (method: string, params: unknown) => {
    const id = String(++n);
    return new Promise<{ result?: unknown; error?: { message?: string } }>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  };
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const reply = await send(method, params);
    expect(reply.error).toBeUndefined();
    return reply.result as T;
  };
  return { call, send };
}

/** A model stand-in that records every text it is handed. */
function recording() {
  const asked: string[] = [];
  const cleanup = async (raw: string): Promise<CleanedDictation> => { asked.push(raw); return { outcome: "cleaned", text: "Fix the login test." }; };
  return { asked, cleanup };
}

describe("dictation.clean", () => {
  it("is off until the switch is turned on, and then asks no model at all", async () => {
    const model = recording();
    const { call } = await boot(model.cleanup);
    expect(await call<CleanResult>("dictation.clean", { text: "um fix the login test" })).toEqual({ outcome: "off", text: "um fix the login test" });
    // Other voice settings saved, the switch never touched: still off.
    await call("settings.set", { key: VOICE_PREFS_KEY, value: { rate: 1.2, handsFree: false } });
    expect((await call<CleanResult>("dictation.clean", { text: "um fix the login test" })).outcome).toBe("off");
    expect(model.asked).toEqual([]);
  });

  it("cleans once the switch is on", async () => {
    const model = recording();
    const { call } = await boot(model.cleanup);
    await call("settings.set", { key: VOICE_PREFS_KEY, value: { cleanUp: true } });
    expect(await call<CleanResult>("dictation.clean", { text: "um fix the login test" })).toEqual({ outcome: "cleaned", text: "Fix the login test." });
    expect(model.asked).toEqual(["um fix the login test"]);
  });

  it("hands back the raw words, and why, when the model drifts or fails", async () => {
    const { call } = await boot(async () => { throw new Error("signed out"); });
    await call("settings.set", { key: VOICE_PREFS_KEY, value: { cleanUp: true } });
    expect(await call<CleanResult>("dictation.clean", { text: "run it" })).toEqual({ outcome: "failed", text: "run it", reason: "signed out" });
    await app.close();
    const drift = await boot(async (raw) => ({ outcome: "kept", text: raw, reason: "drifted" }));
    await drift.call("settings.set", { key: VOICE_PREFS_KEY, value: { cleanUp: true } });
    expect(await drift.call<CleanResult>("dictation.clean", { text: "run it" })).toEqual({ outcome: "kept", text: "run it", reason: "drifted" });
  });

  it("takes words and nothing else", async () => {
    const model = recording();
    const { call, send } = await boot(model.cleanup);
    await call("settings.set", { key: VOICE_PREFS_KEY, value: { cleanUp: true } });
    const withAudio = await send("dictation.clean", { text: "run it", audio: "UklGRiQAAABXQVZF" });
    expect(withAudio.error).toBeDefined();
    expect(model.asked).toEqual([]);
  });

  it("leaves the session's own model alone", async () => {
    const model = recording();
    const { call } = await boot(model.cleanup);
    const p = await call<{ id: string }>("profiles.create", { name: "W" });
    const sp = await call<{ id: string }>("spaces.create", { profileId: p.id, name: "S" });
    const made = await call<{ session: { id: string; model: string | null } }>("sessions.create", { spaceId: sp.id, agentKind: "fake", model: "claude-opus-5-5" });
    await call("settings.set", { key: VOICE_PREFS_KEY, value: { cleanUp: true } });
    await call("dictation.clean", { text: "um fix the login test" });
    expect((await call<{ model: string | null }>("sessions.get", { id: made.session.id })).model).toBe("claude-opus-5-5");
  });
});

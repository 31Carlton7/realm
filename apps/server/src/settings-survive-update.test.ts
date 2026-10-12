import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { newSecretKey } from "@realm/contracts/src/secret-box";
import { createApp, type App } from "./app";
import { eggSecretBox, EGGS_UNLOCKED_KEY } from "./eggs/service";
import { waitFor } from "./test-utils";

/* Packs this file can open. The real ones ship sealed and a suite has no business holding their
   words. Built inside the factory because `vi.mock` is hoisted above every import. */
vi.mock("./eggs/packs", async () => {
  const { sealPack } = await import("./eggs/seal");
  return { EGG_PACKS: [sealPack("alpha-word", "a", { group: "Alpha", labels: [{ present: "Asking Alice", past: "Asked Alice" }], greetings: [] })] };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** A client that plays Electron main's half: it answers `eggsKey` with the key this Mac's keyring
 *  holds, which is the same key across an update. */
async function desktop(port: number, key: string) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  const events: string[] = [];
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  let keyed = false;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if ("id" in m) { pending.get(m.id)?.(m); return; }
    events.push(m.event);
    if (m.event !== "browserHost.op") return;
    const { callId, op } = m.payload as { callId: string; op: string };
    const result = op === "eggsKey" ? { key } : { key: null };
    void call("browserHost.result", { callId, ok: true, result }).then(() => { if (op === "eggsKey") keyed = true; });
  });
  const get = async (k: string) => (await call("settings.get", { key: k })).result.value;
  return { call, get, events, keyed: () => keyed, close: () => ws.close() };
}

const PREFS: Record<string, unknown> = {
  "ui.theme": "dark",
  "ui.themeName.dark": "ayu-mirage-unbordered",
  "ui.themeName.light": "one",
  "ui.easterEggs": true,
  "ui.konamiUnlocked": true,
  "ui.contrast": 70,
  "notifications.sound": false,
};

let apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); eggSecretBox.setKey(null); vi.unstubAllEnvs(); });

describe("an update", () => {
  it("leaves the theme, the Easter eggs and every other app preference exactly as they were", async () => {
    const home = tempDir("realm-update-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const key = newSecretKey().toString("base64");

    // The version before: choose a theme, switch the eggs on, unlock a friend pack.
    const v1 = await createApp({ home, port: 0 }); apps.push(v1);
    const a = await desktop(v1.port, key);
    await a.call("browserHost.register", {});
    await waitFor(() => a.keyed());
    for (const [k, v] of Object.entries(PREFS)) await a.call("settings.set", { key: k, value: v });
    expect((await a.call("eggs.unlock", { passphrase: "alpha-word" })).result.pack).toMatchObject({ group: "Alpha" });
    const remembered = await a.get(EGGS_UNLOCKED_KEY);
    expect(remembered.a).not.toBe("alpha-word"); // sealed under the app's key, as in production
    a.close();
    await v1.close(); apps = [];

    // The version after: a new daemon process, so the key it was handed is gone with the old one.
    eggSecretBox.setKey(null);
    const v2 = await createApp({ home, port: 0 }); apps.push(v2);
    const b = await desktop(v2.port, key);
    // Before the new app has registered — the window in which the old build threw the words away.
    expect(await b.get(EGGS_UNLOCKED_KEY)).toEqual(remembered);
    await b.call("browserHost.register", {});
    await waitFor(() => b.events.includes("eggs.changed"));
    expect((await b.call("eggs.list", {})).result.packs.map((p: Any) => p.group)).toEqual(["Alpha"]);
    for (const [k, v] of Object.entries(PREFS)) expect(await b.get(k), k).toEqual(v);
    expect(await b.get(EGGS_UNLOCKED_KEY)).toEqual(remembered);
    b.close();
  });
});

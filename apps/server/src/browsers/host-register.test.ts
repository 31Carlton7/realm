import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import type { EventPayload } from "@realm/contracts";
import { createApp, type App } from "../app";
import { eggSecretBox } from "../eggs/service";
import { machineSecretBox } from "../machines/secret";
import { oauthSecretBox } from "../mcp/oauth";
import { remoteSecretBox } from "../remote/secret";
import { loopbackRpc, type RpcPort } from "../remote/rpc-port";
import { waitFor } from "../test-utils";

/**
 * Electron main reconnecting, as the server sees it: main's socket drops, and a new one registers.
 * Whatever main's bridge dials — the same server after a blip, or one started after a crash — every
 * key comes over again on the new socket, and the host is seen to go and come back.
 */

const KEY = randomBytes(32).toString("base64");
const apps: App[] = [];
const mains: RpcPort[] = [];

afterEach(async () => {
  for (const main of mains.splice(0)) main.close();
  for (const app of apps.splice(0)) await app.close();
  for (const box of [oauthSecretBox, machineSecretBox, eggSecretBox, remoteSecretBox]) box.setKey(null);
});

/** Main, registering as the host on a socket of its own and answering every key op with `KEY`. */
async function attachMain(app: App): Promise<{ main: RpcPort; asked: string[] }> {
  const main = await loopbackRpc({ port: app.port, token: "unused" });
  mains.push(main);
  const asked: string[] = [];
  main.onEvent((event, payload) => {
    if (event !== "browserHost.op") return;
    const { callId, op } = payload as EventPayload<"browserHost.op">;
    asked.push(op);
    void main.call("browserHost.result", { callId, ok: true, result: { key: KEY } }).catch(() => { /* this socket closed first */ });
  });
  await main.call("browserHost.register", { hasWindow: true });
  return { main, asked };
}

describe("browserHost.register on a reconnect", () => {
  it("asks main for all four keys on every registration, and Realm Mobile unlocks on the new socket", async () => {
    for (const box of [oauthSecretBox, machineSecretBox, eggSecretBox, remoteSecretBox]) box.setKey(null);
    const app = await createApp({ home: tempDir("realm-register-"), port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    apps.push(app);
    const first = await attachMain(app);
    await waitFor(() => first.asked.length === 4);
    expect([...first.asked].sort()).toEqual(["eggsKey", "machineKey", "oauthKey", "remoteKey"]);

    first.main.close();
    // The host went: the window with it, as far as the server can tell.
    const watcher = await loopbackRpc({ port: app.port, token: "unused" });
    mains.push(watcher);
    await waitFor(async () => (await watcher.call("system.info", {})).detachedSince !== null);
    // A daemon that restarted has no keys until main hands them over — the state a respawn starts in.
    remoteSecretBox.setKey(null);
    expect((await watcher.call("remote.status", {})).state).toBe("locked");

    const second = await attachMain(app);
    await waitFor(() => second.asked.length === 4);
    expect([...second.asked].sort()).toEqual(["eggsKey", "machineKey", "oauthKey", "remoteKey"]);
    // And it came back: attached again, with a window, and Realm Mobile no longer locked.
    expect((await watcher.call("system.info", {})).detachedSince).toBeNull();
    await waitFor(async () => (await watcher.call("remote.status", {})).state !== "locked");
  });
});

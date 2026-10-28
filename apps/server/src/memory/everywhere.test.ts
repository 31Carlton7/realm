import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); if (v.error) rej(new Error(`${method}: ${v.error.message}`)); else res(v.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

async function boot(home: string, o: { memoryRepoByDefault?: boolean } = {}) {
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  app = await createApp({ home, port: 0, claudeDir: join(home, "claude-home"), memoryRepoByDefault: o.memoryRepoByDefault ?? true });
  return client(app.port);
}

describe("memory on by default", () => {
  it("gives the first profile a repo at boot and a new profile one as it is made; a detached one stays detached", async () => {
    const home = tempDir("realm-memdefault-app-");
    const c = await boot(home);
    const [personal] = await c.call("profiles.list", {});
    expect((await c.call("memory.repo.get", { profileId: personal.id })).repos).toMatchObject([{ scope: "profile", valid: true }]);
    const work = await c.call("profiles.create", { name: "Work" });
    // Made before `profiles.create` answered, so the page that opens next already has it.
    expect((await c.call("memory.repo.get", { profileId: work.id })).repos).toMatchObject([{ scope: "profile", valid: true }]);
    await c.call("memory.repo.detach", { scope: "profile", ownerId: work.id });
    c.close();
    await app!.close();
    app = null;
    const again = await boot(home);
    expect((await again.call("memory.repo.get", { profileId: work.id })).repos).toEqual([]);
    expect((await again.call("memory.repo.get", { profileId: personal.id })).repos).toHaveLength(1);
    again.close();
  });

  it("makes none in a harness that does not ask for it", async () => {
    const c = await boot(tempDir("realm-memdefault-app-"), { memoryRepoByDefault: false });
    const [personal] = await c.call("profiles.list", {});
    expect((await c.call("memory.repo.get", { profileId: personal.id })).repos).toEqual([]);
    c.close();
  });
});

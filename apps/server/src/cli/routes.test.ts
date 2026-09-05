import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp, type App } from "../app";

let app: App;
afterEach(async () => {
  await app?.close();
});

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`);
    w.once("open", () => res(w));
    w.once("error", rej);
  });
  const pending = new Map<string, (v: any) => void>();
  const events: any[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if ("id" in m) pending.get(m.id)?.(m); else events.push(m);
  });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

/**
 * An app with no agents registered, an empty PATH and a fetch that refuses to be called.
 *
 * All three matter: the suite must not spawn the developer's real agent CLIs, must not classify the
 * developer's real installs, and must not reach npm. What is left is exactly the routes' own logic.
 */
async function boot() {
  const home = tempDir("realm-home-");
  const empty = tempDir("realm-nopath-");
  app = await createApp({
    home, port: 0, adapters: {},
    cli: {
      env: { PATH: empty },
      fetchImpl: (async () => { throw new Error("a route test must not reach a registry"); }) as unknown as typeof fetch,
    },
  });
  return client(app.port);
}

describe("cli.status / cli.run routes", () => {
  it("answers a row for every agent kind, with no agent registered and no network", async () => {
    const c = await boot();
    const { rows } = (await c.call("cli.status", {})).result;
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r: { installed: boolean }) => r.installed === false)).toBe(true);
    // `fake` is compiled in and has no install route, so it must never carry a command.
    expect(rows.find((r: { kind: string }) => r.kind === "fake")).toMatchObject({ action: "none", command: null });
    // Everything else offers its install command and no version, because there is nothing to update.
    expect(rows.find((r: { kind: string }) => r.kind === "codex")).toMatchObject({
      action: "install", command: "npm install -g @openai/codex", latest: null,
    });
    c.close();
  });

  it("refuses an action the status does not offer, whatever the caller asks for", async () => {
    // The named mutant: trusting the caller's `action` instead of re-deriving it. Nothing is
    // installed here, so every kind's offer is "install" — an update must be refused at the route,
    // not by a button that was never rendered.
    const c = await boot();
    const res = await c.call("cli.run", { kind: "codex", action: "update" });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("CLI_ACTION_UNAVAILABLE");
    c.close();
  });

  it("refuses to install a kind that has no install route at all", async () => {
    const c = await boot();
    const res = await c.call("cli.run", { kind: "fake", action: "install" });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("CLI_ACTION_UNAVAILABLE");
    c.close();
  });

  it("rejects a kind that is not an agent, and an action that is not one", async () => {
    const c = await boot();
    expect((await c.call("cli.run", { kind: "not-an-agent", action: "install" })).ok).toBe(false);
    expect((await c.call("cli.run", { kind: "codex", action: "uninstall" })).ok).toBe(false);
    c.close();
  });
});

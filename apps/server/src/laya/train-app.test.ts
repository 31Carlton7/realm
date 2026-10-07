import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { fakeRuntime, until } from "./test-fakes";

/**
 * Train through the real app on a Mac short of memory. What must die: the app's run not guarded —
 * Settings' Train then starts a run that MEASURABLY hung a 24 GB Mac 2½ minutes in.
 */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function rpc(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  let n = 0;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()) as Any; if ("id" in m) pending.get(m.id)?.(m); });
  const call = async (method: string, params: unknown): Promise<Any> => {
    const m = await new Promise<Any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    if (!m.ok) throw new Error(`${method}: ${m.error?.message}`);
    return m.result;
  };
  return { call, close: () => ws.close() };
}

describe("training through the app", () => {
  it("does not start a run on a Mac short of memory, and Settings says why", async () => {
    const home = tempDir("realm-laya-train-app-");
    const ran: string[] = [];
    const runtime = fakeRuntime({ dir: join(home, "laya"), installed: true, base: join(home, "laya", "hf", "base"), runScript: async () => { ran.push("train"); } });
    app = await createApp({ home, port: 0, laya: runtime, layaMachine: async () => ({ pressure: "critical", freeDiskBytes: 100 * 1024 ** 3 }) });
    const r = await rpc(app.port);
    try {
      await r.call("laya.train", {});
      await until(async () => (await r.call("laya.status", {})).training?.state === "failed");
      // THE MUTANT: the app's run not guarded. It starts, on a Mac about to hang.
      expect((await r.call("laya.status", {})).training.reason).toMatch(/This Mac is short of memory right now/);
      expect(ran).toEqual([]);
    } finally {
      r.close();
    }
  }, 30_000);
});

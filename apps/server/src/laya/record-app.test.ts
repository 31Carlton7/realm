import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { PhysicalDevices } from "../simulators/physical";
import { FakePhone, PHONE_UDID } from "../simulators/phone.test-fakes";
import { until } from "./test-fakes";

/**
 * Recording a phone through the real app: its RPC, its simulator service, its recorder, over a scripted
 * phone whose runner answers a read slower than a step may wait. What must die: a recording that reads
 * like a step — TikTok's feed, 36 s a read, was then never recorded at all.
 */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: App | null = null;
const phones: FakePhone[] = [];
afterEach(async () => {
  await app?.close(); app = null;
  await Promise.all(phones.splice(0).map((p) => p.close()));
});

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

describe("recording a phone", () => {
  it("waits for an app slow to describe itself, where a step's read would give up", async () => {
    const phone = await new FakePhone().listen();
    phones.push(phone);
    const home = tempDir("realm-laya-record-app-");
    app = await createApp({
      home, port: 0,
      physicalDevices: (onExit) => new PhysicalDevices({
        home, devicectl: phone.devicectl(), runners: phone.runners(), onExit,
        bridge: async () => ({ streamUrl: "http://127.0.0.1:1/stream.mjpeg", wsUrl: "ws://127.0.0.1:1/ws", port: 1, close: async () => {} }),
        // A step gives up at 100 ms; a patient read waits 3 s. The phone answers in 400 ms.
        timing: { readMs: 100, patientReadMs: 3_000 },
      }),
    });
    const r = await rpc(app.port);
    try {
      const profile = await r.call("profiles.create", { name: "Work" });
      const space = await r.call("spaces.create", { profileId: profile.id, name: "Phone" });
      const { simulatorId } = await r.call("simulators.create", { spaceId: space.id, name: "iPhone", udid: PHONE_UDID });
      await r.call("simulators.start", { simulatorId, udid: PHONE_UDID, platform: "ios", physical: true });
      await until(async () => (await r.call("simulators.get", { simulatorId })).state.status === "running");
      phone.screen = "root";
      phone.readDelayMs = 400;
      // A step's read of the same screen gives up, as it should for an agent waiting on it.
      await expect(r.call("simulators.ax", { simulatorId })).rejects.toThrow(/not answering/);

      await r.call("laya.record", { simulatorId, apps: ["Settings"] });
      // THE MUTANT: the recorder reading as a step does. Every read times out and nothing is kept.
      await until(async () => (await r.call("laya.status", {})).recording?.screens >= 1, 10_000);
      const stopped = await r.call("laya.stopRecording", {});
      expect(stopped.recorded).toMatchObject({ recordings: 1, apps: ["Settings"] });
    } finally {
      r.close();
    }
  }, 30_000);
});

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import type { ResourceReport } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import type { MachineProbe, ProcRow } from "./machine";
import type { Simctl } from "../simulators/simctl";
import type { ServeSim } from "../simulators/serve-sim";
import { REALM_BOOTED_KEY } from "../simulators/service";

/* The report through the real app: every service says what it owns, and a fake process table — built
   at read time from the pids those services really hold — stands in for the Mac. */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res) => {
    const id = String(++n);
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

const MB = 1024 ** 2;
const SIM = "D94F0FDE-7C84-42F1-A328-97EF12A91866";

describe("resources.snapshot through the app", () => {
  it("names each part as the services that own it do: a session's engine, a terminal, a simulator Realm booted", async () => {
    let table: () => ProcRow[] = () => [];
    const probe: MachineProbe = {
      processes: async () => table(),
      footprints: async (pids) => new Map(pids.map((p) => [p, 2 * MB])),
      allFootprints: async () => null,
      memory: async () => ({ memory: { totalBytes: 8 * 1024 * MB, availablePercent: 30, pressure: "warn", pressureWhy: "macOS reports memory pressure", swap: { usedBytes: MB, totalBytes: 2 * MB }, compressedBytes: null, swapOutPerSecond: null, load: [3, 2, 1], cpus: 8 }, counters: { at: 0, swapouts: null } }),
    };
    let bootedAt = 0;
    const simctl: Partial<Simctl> = {
      boot: async () => { bootedAt = Date.now(); return { ok: true, detail: "", booted: true }; },
      devices: async () => [], available: async () => true,
    };
    const serveSim: Partial<ServeSim> = {
      find: async () => ({ running: false, device: null, url: null, streamUrl: null, wsUrl: null, port: null, pid: null }),
      start: async () => ({ stream: { running: true, device: SIM, url: "http://127.0.0.1:1", streamUrl: "http://127.0.0.1:1/s", wsUrl: "ws://127.0.0.1:1/w", port: 1, pid: 9 }, detail: "" }),
      screen: async () => ({ width: 10, height: 20, orientation: "portrait" }),
    };
    app = await createApp({
      home: tempDir("realm-res-"), port: 0,
      adapters: { fake: new FakeAdapter({ script: [{ on: "hi", emit: [{ kind: "text", text: "hello" }] }] }) },
      resources: { probe },
      simulator: { simctl: simctl as Simctl, serveSim: serveSim as ServeSim },
    });
    const c = await client(app.port);
    const prof = (await c.call("profiles.create", { name: "W" })).result;
    const sp = (await c.call("spaces.create", { profileId: prof.id, name: "S" })).result;
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "hi" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.providerSessionId !== null);
    const provider = (await c.call("sessions.get", { id: session.id })).result.providerSessionId as string;
    const term = (await c.call("terminals.create", { spaceId: sp.id })).result;
    const { simulatorId } = (await c.call("simulators.create", { spaceId: sp.id, name: "Persona Onboarding" })).result;
    await c.call("simulators.start", { simulatorId, udid: SIM });
    await waitFor(() => bootedAt > 0);

    const shell = app.terminals.processes().find((t) => t.terminalId === term.terminalId)!;
    const server = process.pid;
    table = () => [
      { pid: server, ppid: 1, tty: null, residentBytes: 100 * MB, startedAt: Date.now() - 60_000, command: "node main.js" },
      { pid: 900_001, ppid: server, tty: null, residentBytes: 300 * MB, startedAt: Date.now(), command: `/x/claude --output-format stream-json --resume=${provider}` },
      { pid: shell.pid, ppid: server, tty: shell.tty?.replace("/dev/", "") ?? null, residentBytes: 3 * MB, startedAt: Date.now(), command: "/bin/zsh -l" },
      { pid: 900_002, ppid: 1, tty: null, residentBytes: 10 * MB, startedAt: bootedAt, command: `launchd_sim /U/Library/Developer/CoreSimulator/Devices/${SIM}/data/var/run/launchd_bootstrap.plist` },
    ];
    const r: ResourceReport = (await c.call("resources.snapshot", { fresh: true })).result;
    expect(r.machine).toMatchObject({ pressure: "warn", pressureWhy: "macOS reports memory pressure" });
    // Titled from its first message, as its sidebar row is.
    expect(r.parts.find((p) => p.ownerId === session.id)).toMatchObject({ category: "engines", label: "hi", residentBytes: 300 * MB });
    expect(r.parts.find((p) => p.ownerId === term.terminalId)).toMatchObject({ category: "terminals", processes: 1 });
    expect(r.parts.find((p) => p.ownerId === SIM)).toMatchObject({ category: "simulators", label: "Persona Onboarding", detail: "Booted by Realm" });
    expect(r.parts.find((p) => p.category === "server")).toMatchObject({ footprintBytes: 2 * MB });
    // The boot is remembered where a restart of the server will find it.
    expect(Object.keys((await c.call("settings.get", { key: REALM_BOOTED_KEY })).result.value)).toEqual([SIM]);
    c.close();
  });

  it("reads as an empty machine in any app main.ts did not build", async () => {
    app = await createApp({ home: tempDir("realm-res-"), port: 0 });
    const c = await client(app.port);
    const r: ResourceReport = (await c.call("resources.snapshot", {})).result;
    expect(r).toMatchObject({ parts: [], others: [], machine: { pressure: "unknown" } });
    c.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { generateDeviceKeys, HomeSchema, MobileCalls, MobileEvents, type Row } from "@realm/remote";
import { startLocalRelay } from "@realm/relay/src/node";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { RemoteGateway } from "./gateway";
import { loopbackRpc, type RpcPort } from "./rpc-port";
import { PhoneCallError, TestPhone } from "./test-phone";

/**
 * Plan 28's pipe, end to end in one process: a real realm-server (createApp, fake agent), the gateway
 * dialling it over loopback, the relay's own core behind a local socket server, and a TypeScript phone
 * speaking PROTOCOL.md. What the phone can do, and what it must never be able to do, are both here.
 */

type Rig = { app: App; rpc: RpcPort; relay: { url: string; close(): Promise<void> }; gw: RemoteGateway; spaceId: string; confirm: { answer: boolean } };

let rig: Rig | null = null;

async function boot(): Promise<Rig> {
  const home = tempDir("realm-remote-");
  const app = await createApp({
    home, port: 0,
    adapters: { fake: new FakeAdapter({ script: [
      { on: "stream", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 15 }] },
      { on: "ask me", emit: [{ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered", input: { questions: [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }] },
      { on: "run it", emit: [{ kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm test" }, result: "ok" }] },
    ] }) },
  });
  const rpc = await loopbackRpc({ port: app.port, token: "unused" });
  const relay = await startLocalRelay({ port: 0 });
  const confirm = { answer: true };
  const gw = new RemoteGateway({ home, relay: relay.url, rpc, macName: "Test Mac", version: "test", confirm: async () => confirm.answer, dev: true, log: process.env.REMOTE_DEBUG ? (l) => console.log(l) : undefined });
  gw.start();
  await waitFor(() => gw.state === "connected", { timeout: 5_000 });
  const [profile] = await rpc.call("profiles.list", {});
  const space = await rpc.call("spaces.create", { profileId: profile!.id, name: "Spike" });
  return { app, rpc, relay, gw, spaceId: space.id, confirm };
}

async function paired(r: Rig): Promise<TestPhone> {
  const phone = new TestPhone();
  expect(await phone.pair(r.gw.openPairing().url)).toEqual({ ok: true });
  await phone.connect();
  return phone;
}

async function newSession(r: Rig): Promise<string> {
  const { session } = await r.rpc.call("sessions.create", { spaceId: r.spaceId, agentKind: "fake" });
  return session.id;
}

const rowsOf = (p: unknown, id: string): Row[] | undefined => {
  const e = MobileEvents["session.rows"].parse(p);
  return e.id === id ? e.rows : undefined;
};

beforeEach(async () => { rig = await boot(); });
afterEach(async () => {
  if (!rig) return;
  rig.gw.stop();
  rig.rpc.close();
  await rig.relay.close();
  await rig.app.close();
  rig = null;
});

describe("Plan 28: the pipe", () => {
  it("pairs a phone that holds the QR code, after the owner says yes", async () => {
    const r = rig!;
    const phone = await paired(r);
    expect(r.gw.devices().map((d) => d.phoneId)).toEqual([phone.phoneId]);
    expect(phone.mac?.macName).toBe("Test Mac");
    phone.close();
  });

  it("does not pair when the owner says no, and the phone hears why", async () => {
    const r = rig!;
    r.confirm.answer = false;
    const phone = new TestPhone();
    expect(await phone.pair(r.gw.openPairing().url)).toEqual({ ok: false, reason: "declined" });
    expect(r.gw.devices()).toEqual([]);
  });

  it("refuses a pairing link whose secret is wrong, without asking the owner", async () => {
    const r = rig!;
    let asked = false;
    const url = r.gw.openPairing().url;
    (r.gw as unknown as { o: { confirm: () => Promise<boolean> } }).o.confirm = async () => { asked = true; return true; };
    const [base, data] = url.split("#1.") as [string, string];
    const fields = JSON.parse(Buffer.from(data, "base64url").toString()) as Record<string, unknown>;
    fields.s = Buffer.alloc(32, 9).toString("base64url");
    const forged = `${base}#1.${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
    await expect(new TestPhone().pair(forged, { timeoutMs: 2_000 })).rejects.toThrow();
    expect(asked).toBe(false);
    expect(r.gw.devices()).toEqual([]);
  });

  it("lists home, opens a session and streams its rows as the agent writes", async () => {
    const r = rig!;
    const id = await newSession(r);
    const phone = await paired(r);
    const home = HomeSchema.parse(await phone.call("home.get"));
    expect(home.mac.name).toBe("Test Mac");
    expect(home.spaces.find((s) => s.id === r.spaceId)?.sessions.map((s) => s.id)).toEqual([id]);
    const opened = MobileCalls["session.open"].result.parse(await phone.call("session.open", { id }));
    expect(opened.session.id).toBe(id);

    const streamed: string[] = [];
    phone.on("session.rows", (p) => {
      for (const row of rowsOf(p, id) ?? []) if (row.kind === "assistant") streamed.push(`${row.streaming ? "…" : "="}${row.text}`);
    });
    await phone.call("session.send", { id, text: "stream please" });
    await waitFor(() => streamed.some((s) => s === "=one two three four five six seven eight"), { timeout: 5_000 });
    // Deltas arrive as growing partial rows before the final one replaces them in place.
    expect(streamed.filter((s) => s.startsWith("…")).length).toBeGreaterThan(0);
    phone.close();
  });

  it("answers a question card from the phone, and the agent goes on", async () => {
    const r = rig!;
    const id = await newSession(r);
    const phone = await paired(r);
    await phone.call("session.open", { id });
    const pending = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "request" && row.state === "pending"));
    await phone.call("session.send", { id, text: "ask me something" });
    const request = await pending;
    expect(request.kind === "request" && request.questions?.[0]?.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    const allowed = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "request" && row.state === "allowed"));
    await phone.call("session.answer", { id, requestId: request.kind === "request" ? request.requestId : "", decision: "allow", answers: { "Which database?": "SQLite" } });
    await allowed;
    phone.close();
  });

  it("only streams the sessions a phone has open", async () => {
    const r = rig!;
    const open = await newSession(r);
    const other = await newSession(r);
    const phone = await paired(r);
    await phone.call("session.open", { id: open });
    const seen = new Set<string>();
    phone.on("session.rows", (p) => { seen.add(MobileEvents["session.rows"].parse(p).id); });
    await r.rpc.call("sessions.send", { id: other, text: "hello other" });
    await r.rpc.call("sessions.send", { id: open, text: "hello open" });
    await waitFor(() => seen.has(open), { timeout: 5_000 });
    await new Promise((res) => setTimeout(res, 300));
    expect([...seen]).toEqual([open]);
    phone.close();
  });

  it("refuses calls that are not mobile.v1, and bad params, by code", async () => {
    const r = rig!;
    const phone = await paired(r);
    await expect(phone.call("sessions.delete", { id: "x" })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(phone.call("terminals.create", { spaceId: r.spaceId })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(phone.call("session.send", { id: "x" })).rejects.toBeInstanceOf(PhoneCallError);
    await expect(phone.call("session.open", { id: "01JA00000000000000000000ZZ" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(phone.call("session.open", { id: "not-a-ulid" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    phone.close();
  });

  it("drops a phone the moment the Mac removes it", async () => {
    const r = rig!;
    const phone = await paired(r);
    expect(r.gw.revoke(phone.phoneId)).toBe(true);
    await expect(phone.call("ping")).rejects.toThrow();
    // Refused by the relay itself (4403), not only by the Mac behind it: the relay has forgotten the
    // phone's key, so a lost phone cannot even reach the Mac's socket to try.
    await expect(phone.connect()).rejects.toThrow(/socket closed 4403/);
  });

  it("will not talk to a phone whose relay key is paired but whose Noise key is not", async () => {
    const r = rig!;
    const phone = await paired(r);
    phone.close();
    // Same signing key (the relay lets it in), different X25519 key: the Mac must refuse the handshake.
    const impostor = new TestPhone({ sign: phone.keys.sign, dh: generateDeviceKeys().dh }, phone.mac);
    await expect(impostor.connect()).rejects.toThrow();
  });
});

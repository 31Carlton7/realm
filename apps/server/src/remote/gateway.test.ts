import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { REMOTE_RELAY_KEY, sessionEvent, type EventName, type EventPayload, type MethodName } from "@realm/contracts";
import { isSealed } from "@realm/contracts/src/secret-box";
import { fromB64u, generateDeviceKeys, HandshakeState, HomeSchema, MobileCalls, MobileEvents, PROLOGUE, type Row } from "@realm/remote";
import { startLocalRelay, type ApnsPush, type LocalRelay } from "@realm/relay/src/node";
import WebSocket, { WebSocketServer } from "ws";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { fakeRpc, session as fakeSession, type Lists } from "./api.test-fakes";
import { RemoteGateway } from "./gateway";
import { REMOTE_IDENTITY_KEY } from "./keys";
import { collapseId } from "./push";
import { loopbackRpc, type RpcPort } from "./rpc-port";
import { remoteSecretBox } from "./secret";
import { FileRemoteStore } from "./store";
import { PhoneCallError, TestPhone } from "./test-phone";

/**
 * Plan 28's pipe, end to end in one process, the way the product runs it: a real realm-server
 * (createApp, fake agent) whose own RemoteService answers phones through `RpcServer.call()`, the
 * relay's core behind a local socket server, a TypeScript phone speaking PROTOCOL.md, and a socket
 * standing in for Electron main — it hands over the `remote` key and answers for Settings ▸ Devices.
 */

type Rig = { app: App; home: string; mac: RpcPort; relay: LocalRelay; pushes: ApnsPush[]; spaceId: string };

const KEY = randomBytes(32).toString("base64");
const rigs: Rig[] = [];
const relays: LocalRelay[] = [];

const fake = () => new FakeAdapter({ script: [
  { on: "stream", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 15 }] },
  { on: "ask me", emit: [{ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered", input: { questions: [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }] },
  { on: "run it", emit: [{ kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm test" }, result: "ok" }] },
  { on: "pick regions", emit: [{ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered", input: { questions: [
    { question: "Which regions?", header: "Regions", multiSelect: true, options: [{ label: "us-east" }, { label: "eu-west" }] },
    { question: "What is the deploy token?", header: "Token", multiSelect: false, options: [], secret: true },
  ] } }] },
  { on: "plan it", emit: [
    { kind: "plan", planId: "p1", steps: [{ text: "Add the column", status: "pending" }, { text: "Backfill it", status: "pending" }] },
    { kind: "tool", name: "ExitPlanMode", needsPermission: true, input: { plan: "## Theme column\n\nAdd it, then backfill it." }, result: "Approved" },
  ] },
  // A turn that takes a few seconds, so messages sent during it wait in the queue.
  { on: "take your time", emit: [{ kind: "text", text: Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "), paceMs: 120 }] },
  // A team's role sending its work to Review: a post with its picture, and an email.
  { on: "send for review", emit: [
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "launch", title: "Dark mode launch", items: [
      { files: ["renders/toggle.png"], body: "Dark mode is here.", target: { channel: "instagram", account: "@realm" } },
      { body: "Hi Dana, it ships Friday.", meta: { Subject: "It ships Friday" } },
    ] } },
    { kind: "text", text: "Sent to Review." },
  ] },
  // The edit changes the file's size: one of the same size, made in the second git last looked at it,
  // can read as unchanged to git's stat check ("racy git"), and the turn would not count it.
  { on: "edit", emit: [
    { kind: "tool", name: "Edit", apply: true, input: { file_path: "a.txt", old_string: "one", new_string: "one, then two" }, result: "ok" },
    { kind: "tool", name: "Write", apply: true, input: { file_path: "notes/new.md", content: "# New\n\nhello\n" }, result: "created" },
  ] },
] });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

/** The first `event` the Mac's socket hears that `pick` accepts. */
function nextEvent<E extends EventName>(rpc: RpcPort, event: E, pick: (p: EventPayload<E>) => boolean = () => true, timeoutMs = 5_000): Promise<EventPayload<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${event}`)); }, timeoutMs);
    const off = rpc.onEvent((e: EventName, p: unknown) => {
      if (e !== event || !pick(p as EventPayload<E>)) return;
      clearTimeout(timer);
      off();
      resolve(p as EventPayload<E>);
    });
  });
}

/** A relay that has stopped listening to the Mac: it forwards every frame both ways, but once told to,
 *  it swallows the Mac's new phone list — so a phone the Mac removes keeps its socket, and only the Mac
 *  itself can cut it off. */
async function forgetfulRelay(upstream: string): Promise<LocalRelay & { forget: boolean }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const proxy = { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, forget: false, close: async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  } };
  wss.on("connection", (client, req) => {
    const up = new WebSocket(`${upstream}${req.url ?? ""}`, { perMessageDeflate: false });
    const queued: { data: Buffer; binary: boolean }[] = [];
    client.on("message", (data: Buffer, binary: boolean) => {
      if (proxy.forget && !binary && req.url?.startsWith("/v1/mac/") && data.toString().includes('"t":"phones"')) return;
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary }); else queued.push({ data, binary });
    });
    up.on("open", () => { for (const m of queued.splice(0)) up.send(m.data, { binary: m.binary }); });
    up.on("message", (data: Buffer, binary: boolean) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
    const code = (c: number) => (c >= 1000 && c <= 4999 && c !== 1005 && c !== 1006 ? c : 1000);
    up.on("close", (c, reason) => client.close(code(c), reason));
    client.on("close", (c, reason) => up.close(code(c), reason));
    up.on("error", () => client.terminate());
    client.on("error", () => up.terminate());
  });
  return proxy;
}

/** Electron main, as far as Realm Mobile can tell: a socket that registers as the browser host and
 *  answers the key ops — `remoteKey` with `key`, the rest with none. */
async function attachMac(app: App, key: string | null): Promise<RpcPort> {
  const rpc = await loopbackRpc({ port: app.port, token: "unused" });
  rpc.onEvent((event, payload) => {
    if (event !== "browserHost.op") return;
    const { callId, op } = payload as EventPayload<"browserHost.op">;
    void rpc.call("browserHost.result", { callId, ok: true, result: { key: op === "remoteKey" ? key : null } });
  });
  await rpc.call("browserHost.register", { hasWindow: true });
  return rpc;
}

async function boot(o: { home?: string; relay?: LocalRelay; key?: string | null; pairTtlMs?: number; pushHoldMs?: number } = {}): Promise<Rig> {
  // The box is module-wide, so each app here starts without a key and gets one the way the real
  // daemon does: from Electron main, when it registers.
  remoteSecretBox.setKey(null);
  const pushes: ApnsPush[] = [];
  const relay = o.relay ?? await startLocalRelay({ port: 0, apns: { send: async (p) => { pushes.push(p); return { ok: true, status: 200, reason: null }; } } });
  if (!o.relay) relays.push(relay);
  const home = o.home ?? tempDir("realm-remote-");
  const app = await createApp({ home, port: 0, adapters: { fake: fake() }, remote: { dev: true, pairTtlMs: o.pairTtlMs, pushHoldMs: o.pushHoldMs } });
  const mac = await attachMac(app, o.key === undefined ? KEY : o.key);
  await mac.call("settings.set", { key: REMOTE_RELAY_KEY, value: relay.url });
  const [profile] = await mac.call("profiles.list", {});
  const spaces = await mac.call("spaces.list", {});
  const spaceId = spaces[0]?.id ?? (await mac.call("spaces.create", { profileId: profile!.id, name: "Spike" })).id;
  const rig = { app, home, mac, relay, pushes, spaceId };
  rigs.push(rig);
  return rig;
}

const status = (r: Rig) => r.mac.call("remote.status", {});

/** Pairs through Settings: the window, the phone's handshake, and the owner's yes. */
async function pairPhone(r: Rig, phone = new TestPhone()): Promise<TestPhone> {
  const asked = nextEvent(r.mac, "remote.pairRequest");
  const { url } = await r.mac.call("remote.pair.start", {});
  const paired = phone.pair(url, { name: "Carlton's iPhone", model: "iPhone18,1" });
  const request = await asked;
  await r.mac.call("remote.pair.answer", { requestId: request.requestId, accept: true });
  expect(await paired).toEqual({ ok: true });
  await phone.connect();
  return phone;
}

async function newSession(r: Rig): Promise<string> {
  const { session } = await r.mac.call("sessions.create", { spaceId: r.spaceId, agentKind: "fake" });
  return session.id;
}

const rowsOf = (p: unknown, id: string): Row[] | undefined => {
  const e = MobileEvents["session.rows"].parse(p);
  return e.id === id ? e.rows : undefined;
};

afterEach(async () => {
  for (const r of rigs.splice(0)) { r.mac.close(); await r.app.close(); }
  for (const relay of relays.splice(0)) await relay.close();
  remoteSecretBox.setKey(null);
});

describe("Plan 28: pairing from Settings ▸ Devices", () => {
  it("pairs a phone that holds the QR code only once the owner says yes, and tells Settings at each step", async () => {
    const r = await boot();
    expect(await status(r)).toMatchObject({ state: "off", phones: [], pairing: null, relay: r.relay.url });
    const changes: EventPayload<"remote.changed">[] = [];
    r.mac.onEvent((e, p) => { if (e === "remote.changed") changes.push(p as EventPayload<"remote.changed">); });

    const asked = nextEvent(r.mac, "remote.pairRequest");
    const window = await r.mac.call("remote.pair.start", {});
    await waitFor(async () => (await status(r)).state === "connected");
    const phone = new TestPhone();
    const paired = phone.pair(window.url, { name: "Carlton's iPhone", model: "iPhone18,1" });
    const request = await asked;
    expect(request).toMatchObject({ windowId: window.windowId, name: "Carlton's iPhone", model: "iPhone18,1" });
    // THE mutant: pair on the handshake alone. Holding the code is not enough; the owner has not answered.
    await new Promise((res) => setTimeout(res, 200));
    expect((await status(r)).phones).toEqual([]);

    await r.mac.call("remote.pair.answer", { requestId: request.requestId, accept: true });
    expect(await paired).toEqual({ ok: true });
    const after = await status(r);
    expect(after.phones).toEqual([{ phoneId: phone.phoneId, name: "Carlton's iPhone", model: "iPhone18,1", addedAt: expect.any(Number), lastSeen: null }]);
    expect(after.pairing).toBeNull();
    // Settings heard the window open, the link come up and the phone arrive, without asking again.
    expect(changes.some((c) => c.pairing?.windowId === window.windowId)).toBe(true);
    expect(changes.some((c) => c.state === "connected")).toBe(true);
    expect(changes.at(-1)?.phones.map((p) => p.phoneId)).toEqual([phone.phoneId]);

    await phone.connect();
    expect(phone.mac?.macName).toBe((await r.mac.call("system.info", {})).machineName);
    await waitFor(async () => (await status(r)).phones[0]?.lastSeen !== null);
    phone.close();
  });

  it("does not pair when the owner says no, and the phone hears why", async () => {
    const r = await boot();
    const asked = nextEvent(r.mac, "remote.pairRequest");
    const phone = new TestPhone();
    const paired = phone.pair((await r.mac.call("remote.pair.start", {})).url);
    await r.mac.call("remote.pair.answer", { requestId: (await asked).requestId, accept: false });
    expect(await paired).toEqual({ ok: false, reason: "declined" });
    expect((await status(r)).phones).toEqual([]);
    // A stale answer to a request that is gone says so, rather than pairing anything.
    await expect(r.mac.call("remote.pair.answer", { requestId: "gone", accept: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a window nobody answers expires: the phone hears so, and the Mac stops dialling", async () => {
    const r = await boot({ pairTtlMs: 1_200 });
    const asked = nextEvent(r.mac, "remote.pairRequest");
    const paired = new TestPhone().pair((await r.mac.call("remote.pair.start", {})).url);
    const { requestId } = await asked;
    expect(await paired).toEqual({ ok: false, reason: "expired" });
    await waitFor(async () => (await status(r)).state === "off");
    expect((await status(r)).pairing).toBeNull();
    await expect(r.mac.call("remote.pair.answer", { requestId, accept: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await status(r)).phones).toEqual([]);
  });

  it("cancelling the window says no to a phone still waiting on the owner", async () => {
    const r = await boot();
    const asked = nextEvent(r.mac, "remote.pairRequest");
    const paired = new TestPhone().pair((await r.mac.call("remote.pair.start", {})).url);
    await asked;
    await r.mac.call("remote.pair.cancel", {});
    expect(await paired).toEqual({ ok: false, reason: "declined" });
    await waitFor(async () => (await status(r)).state === "off");
  });

  it("gives a phone that holds the code nothing before the owner's yes: its pairing channel reaches no call", async () => {
    const r = await boot();
    const asked = nextEvent(r.mac, "remote.pairRequest");
    const { url } = await r.mac.call("remote.pair.start", {});
    // THE mutant: answer calls on the pairing channel. Then a photograph of the QR code is a way in,
    // with the owner's sheet still on screen and unanswered.
    for (const method of ["home.get", "ping"]) {
      expect(await new TestPhone().callWhilePairing(url, method), method).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
    await asked;
    expect((await status(r)).phones).toEqual([]);
  });

  it("refuses a pairing link whose secret is wrong, without asking the owner", async () => {
    const r = await boot();
    let asked = false;
    r.mac.onEvent((e) => { if (e === "remote.pairRequest") asked = true; });
    const url = (await r.mac.call("remote.pair.start", {})).url;
    const [base, data] = url.split("#1.") as [string, string];
    const fields = JSON.parse(Buffer.from(data, "base64url").toString()) as Record<string, unknown>;
    fields.s = Buffer.alloc(32, 9).toString("base64url");
    const forged = `${base}#1.${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
    await expect(new TestPhone().pair(forged, { timeoutMs: 2_000 })).rejects.toThrow();
    expect(asked).toBe(false);
    expect((await status(r)).phones).toEqual([]);
  });

  it("is locked until Electron main hands over the key, keeps its identity sealed, and comes back for its phones", async () => {
    const relay = await startLocalRelay({ port: 0 });
    relays.push(relay);
    const first = await boot({ relay });
    const phone = await pairPhone(first);
    const stored = await first.mac.call("settings.get", { key: REMOTE_IDENTITY_KEY });
    // The private keys are sealed under the `remote` domain, never written in the clear.
    expect(typeof stored.value === "string" && isSealed(stored.value)).toBe(true);
    phone.close();
    first.mac.close();
    await first.app.close();
    rigs.splice(rigs.indexOf(first), 1);

    // The daemon restarts with no Realm attached: it has no key, so it cannot open who it is.
    const again = await boot({ home: first.home, relay, key: null });
    expect(await status(again)).toMatchObject({ state: "locked", phones: [{ phoneId: phone.phoneId }] });
    await expect(again.mac.call("remote.pair.start", {})).rejects.toMatchObject({ code: "REMOTE_LOCKED" });
    // Realm opens: main registers with the key, and the paired phone's Mac is back, as the same Mac.
    again.mac.close();
    again.mac = await attachMac(again.app, KEY);
    await waitFor(async () => (await status(again)).state === "connected");
    await phone.connect();
    expect(await phone.call("ping")).toMatchObject({ at: expect.any(Number) });
    phone.close();
  });

  it("refuses Settings' calls from a phone's principal, and the host registration from anything but a socket", async () => {
    const r = await boot();
    const asPhone = { client: null, principal: "phone:abc" } as const;
    for (const [method, params] of [["remote.status", {}], ["remote.pair.start", {}], ["remote.pair.cancel", {}],
      ["remote.pair.answer", { requestId: "x", accept: true }], ["remote.phones.remove", { phoneId: "x" }], ["remote.away", { away: false }]] as const) {
      await expect(r.app.rpc.call(method, params, asPhone), method).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(r.app.rpc.call("browserHost.register", { hasWindow: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(r.app.rpc.call("browserHost.register", { hasWindow: true }, asPhone)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The window is the Mac's own register, still in place.
    expect((await r.mac.call("system.info", {})).detachedSince).toBeNull();
  });
});

describe("Plan 28: a paired phone, in process", () => {
  it("lists home, opens a session and streams its rows as the agent writes", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    const home = HomeSchema.parse(await phone.call("home.get"));
    expect(home.mac.name).toBe((await r.mac.call("system.info", {})).machineName);
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
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
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

  it("asks the desktop's question on the phone: several picks, words of its own, and a secret that never comes back", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    await phone.call("session.open", { id });
    const heard: string[] = [];
    phone.on("*", (m) => { heard.push(JSON.stringify(m)); });
    const pending = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "request" && row.state === "pending"));
    await phone.call("session.send", { id, text: "pick regions" });
    const request = await pending;
    if (request.kind !== "request") throw new Error("not a request");
    expect(request.questions).toMatchObject([
      { id: "Which regions?", multiSelect: true, allowOther: true, secret: false, options: [{ label: "us-east" }, { label: "eu-west" }] },
      { id: "What is the deploy token?", kind: "text", secret: true },
    ]);
    const token = `tok_${randomBytes(6).toString("hex")}`;
    const allowed = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "request" && row.state === "allowed"));
    await phone.call("session.answer", { id, requestId: request.requestId, decision: "allow", answers: { "Which regions?": ["us-east", "ap-south"], "What is the deploy token?": token } });
    const done = await allowed;
    // The picks as a list, the region of its own beside them; the secret as its mark alone.
    expect(done.kind === "request" && done.answers).toEqual({ "Which regions?": ["us-east", "ap-south"], "What is the deploy token?": "••••••" });
    await new Promise((res) => setTimeout(res, 200));
    expect(heard.filter((h) => h.includes(token))).toEqual([]);
    phone.close();
  });

  it("shows the plan a session asks to have approved, with its steps", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    await phone.call("session.open", { id });
    const pending = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "request" && row.state === "pending"));
    await phone.call("session.send", { id, text: "plan it" });
    expect(await pending).toMatchObject({ tool: "ExitPlanMode", questions: null, plan: {
      text: "## Theme column\n\nAdd it, then backfill it.", steps: [{ text: "Add the column", status: "pending" }, { text: "Backfill it", status: "pending" }],
    } });
    phone.close();
  });

  it("offers the suggested next message, and takes it away once something is sent", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    r.app.sessions.publishServerEvent(id, sessionEvent("prompt_hint", { text: "Now run the tests", throughSeq: 1 }));
    expect(MobileCalls["session.open"].result.parse(await phone.call("session.open", { id })).hint).toBe("Now run the tests");
    const next = phone.waitFor("session.hint", (p) => MobileEvents["session.hint"].parse(p));
    r.app.sessions.publishServerEvent(id, sessionEvent("prompt_hint", { text: "Ship it", throughSeq: 2 }));
    expect(await next).toEqual({ id, text: "Ship it" });
    const cleared = phone.waitFor("session.hint", (p) => { const e = MobileEvents["session.hint"].parse(p); return e.text === null ? e : undefined; });
    await phone.call("session.send", { id, text: "hello" });
    expect(await cleared).toEqual({ id, text: null });
    phone.close();
  });

  it("opens a turn's changes and pages its diff, from the turn's own checkpoint and nothing else", async () => {
    const r = await boot();
    const [profile] = await r.mac.call("profiles.list", {});
    const repo = await r.mac.call("spaces.create", { profileId: profile!.id, name: "Repo" });
    git(repo.folderPath, "init", "-q", "-b", "main");
    writeFileSync(join(repo.folderPath, "a.txt"), "one\n");
    git(repo.folderPath, "add", ".");
    git(repo.folderPath, "commit", "-qm", "init");
    const { session } = await r.mac.call("sessions.create", { spaceId: repo.id, agentKind: "fake" });
    const phone = await pairPhone(r);
    await phone.call("session.open", { id: session.id });
    const notice = phone.waitFor("session.rows", (p) => rowsOf(p, session.id)?.find((row) => row.kind === "notice" && row.checkpointId), 15_000);
    await phone.call("session.send", { id: session.id, text: "edit" });
    const row = await notice;
    const checkpointId = row.kind === "notice" ? row.checkpointId! : "";
    const changes = MobileCalls["session.changes"].result.parse(await phone.call("session.changes", { id: session.id, checkpointId }));
    expect(changes.files.map((f) => [f.path, f.status, f.additions, f.deletions]).sort()).toEqual([["a.txt", "modified", 1, 1], ["notes/new.md", "added", 3, 0]]);
    const diff = MobileCalls["session.diff"].result.parse(await phone.call("session.diff", { id: session.id, checkpointId, path: "a.txt" }));
    expect(diff.lines).toEqual(["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "+one, then two"].map((l) => (l.startsWith("@@") ? expect.stringMatching(/^@@ -1(,1)? \+1(,1)? @@/) : l)));
    // A file in the same repository that this turn did not change is not the phone's to read.
    writeFileSync(join(repo.folderPath, "secret.env"), "KEY=1\n");
    await expect(phone.call("session.diff", { id: session.id, checkpointId, path: "secret.env" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nor is another session's turn this session's.
    const other = await newSession(r);
    await expect(phone.call("session.changes", { id: other, checkpointId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    phone.close();
  });

  it("previews a file a session made, and refuses one it did not", async () => {
    const r = await boot();
    const id = await newSession(r);
    const dir = tempDir("realm-made-");
    writeFileSync(join(dir, "deck.md"), "# The deck\n\nThree slides.\n");
    writeFileSync(join(dir, "private.md"), "not the turn's\n");
    r.app.sessions.publishServerEvent(id, sessionEvent("files_made", { settledAt: 1, files: [{ path: join(dir, "deck.md"), size: 27 }], totalFiles: 1 }));
    const phone = await pairPhone(r);
    const opened = MobileCalls["session.open"].result.parse(await phone.call("session.open", { id }));
    expect(opened.rows.find((row) => row.kind === "notice")).toMatchObject({ files: [{ path: join(dir, "deck.md"), size: 27 }] });
    expect(await phone.call("session.file", { id, path: join(dir, "deck.md") })).toMatchObject({ name: "deck.md", preview: { kind: "text", text: "# The deck\n\nThree slides.\n" } });
    for (const path of [join(dir, "private.md"), "/etc/hosts", join(r.home, "realm.db")]) {
      await expect(phone.call("session.file", { id, path }), path).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    phone.close();
  });

  it("takes files with a message: written under the Mac's own home, and the session is sent their paths", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    await phone.call("session.open", { id });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const shown = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "user" && (row.attachments?.length ?? 0) > 0));
    await phone.call("session.send", { id, text: "What is in these?", attachments: [
      { name: "IMG_0042.png", mime: "image/png", data: png.toString("base64") },
      { name: "../../notes.md", mime: "text/markdown", data: Buffer.from("# Notes\n").toString("base64") },
    ] });
    const row = await shown;
    if (row.kind !== "user" || !row.attachments) throw new Error("no files on the row");
    const dir = join(r.home, "tmp", "attachments");
    // Written under a name of the Mac's own, and named on the row as the phone named it.
    expect(row.attachments.map((a) => [dirname(a.path), a.name, a.mime])).toEqual([[dir, "IMG_0042.png", "image/png"], [dir, "notes.md", "text/markdown"]]);
    expect(row.attachments.map((a) => basename(a.path))).toEqual([expect.stringMatching(/^[0-9a-f]{12}-IMG_0042\.png$/), expect.stringMatching(/^[0-9a-f]{12}-notes\.md$/)]);
    expect(readFileSync(row.attachments[0]!.path)).toEqual(png);
    // The session's own record of the message holds those paths, as a desktop paste's does.
    const [sent] = await r.mac.call("sessions.events", { id, afterSeq: 0, limit: 10, types: ["user_message"] });
    expect(sent?.event.payload).toMatchObject({ text: "What is in these?", attachments: row.attachments.map(({ path, mime }) => ({ path, mime })) });
    // And the phone may preview them, as it previews what a turn made.
    expect(await phone.call("session.file", { id, path: row.attachments[1]!.path })).toMatchObject({ name: "notes.md", preview: { kind: "text", text: "# Notes\n" } });
    // A file the Mac cannot take is refused before anything is written or sent.
    const before = readdirSync(dir).length;
    await expect(phone.call("session.send", { id, text: "", attachments: [{ name: "IMG.heic", mime: "image/heic", data: "aGVpYw==" }] })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(readdirSync(dir)).toHaveLength(before);
    phone.close();
  });

  it("reads and changes a session's model, mode and permissions from the phone, as the desktop's chips do", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    const options = MobileCalls["session.options"].result.parse(await phone.call("session.options", { id }));
    expect(options.agent).toMatchObject({ kind: "fake", modes: [{ id: "build" }, { id: "plan" }, { id: "ask" }], permissions: [{ id: "default" }, { id: "acceptEdits" }, { id: "bypassPermissions" }] });
    expect(options).toMatchObject({ model: null, permissionMode: "default", midTurn: "queue" });
    const planned = MobileCalls["session.configure"].result.parse(await phone.call("session.configure", { id, mode: "plan" }));
    expect(planned.permissionMode).toBe("plan");
    expect((await r.mac.call("sessions.get", { id })).permissionMode).toBe("plan");
    await phone.call("session.configure", { id, permission: "acceptEdits", model: "fake" });
    expect(await r.mac.call("sessions.get", { id })).toMatchObject({ permissionMode: "acceptEdits", model: "fake" });
    await expect(phone.call("session.configure", { id, permission: "sudo" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(MobileCalls["agents.list"].result.parse(await phone.call("agents.list")).agents.map((a) => a.kind)).toContain("claude");
    phone.close();
  });

  it("keeps Home in the order its conversations moved: a session set up again since stays where it was", async () => {
    const r = await boot();
    // A few milliseconds apart, so neither the two sessions nor the two writes share a clock tick.
    const tick = () => new Promise((res) => setTimeout(res, 20));
    const older = await newSession(r);
    await tick();
    const newer = await newSession(r);
    await tick();
    // A change of settings writes the older row, which moves its `updatedAt` past the newer's, and
    // reading it moves its read mark; neither is the conversation moving.
    await r.mac.call("sessions.setOptions", { id: older, permissionMode: "acceptEdits" });
    await r.mac.call("sessions.markSeen", { id: older, seq: 0 });
    const [o, n] = [await r.mac.call("sessions.get", { id: older }), await r.mac.call("sessions.get", { id: newer })];
    expect(o.updatedAt).toBeGreaterThan(n.updatedAt);
    const phone = await pairPhone(r);
    const home = HomeSchema.parse(await phone.call("home.get"));
    const page = MobileCalls["space.sessions"].result.parse(await phone.call("space.sessions", { id: r.spaceId }));
    for (const rows of [home.spaces.find((sp) => sp.id === r.spaceId)!.sessions, home.recent!, page.sessions]) {
      expect(rows.map((s) => s.id)).toEqual([newer, older]);
    }
    expect(home.recent!.map((s) => s.activityAt)).toEqual([n.activityAt, o.activityAt]);
    // A message is the conversation moving, and puts the older first.
    await r.mac.call("sessions.send", { id: older, text: "hello again" });
    await waitFor(async () => HomeSchema.parse(await phone.call("home.get")).recent![0]!.id === older);
    phone.close();
  });

  it("lists Home for one profile, and a space's sessions a page at a time", async () => {
    const r = await boot();
    const [profile] = await r.mac.call("profiles.list", {});
    const ids = [await newSession(r), await newSession(r)];
    const phone = await pairPhone(r);
    const home = HomeSchema.parse(await phone.call("home.get", { profileId: profile!.id }));
    expect(home.profileId).toBe(profile!.id);
    expect(home.profiles?.map((p) => p.id)).toEqual([profile!.id]);
    expect(home.recent?.map((s) => s.id).sort()).toEqual([...ids].sort());
    const page = MobileCalls["space.sessions"].result.parse(await phone.call("space.sessions", { id: r.spaceId, limit: 1 }));
    expect(page.sessions).toHaveLength(1);
    expect(page.more).toBe(true);
    phone.close();
  });

  it("only streams the sessions a phone has open", async () => {
    const r = await boot();
    const open = await newSession(r);
    const other = await newSession(r);
    const phone = await pairPhone(r);
    await phone.call("session.open", { id: open });
    const seen = new Set<string>();
    phone.on("session.rows", (p) => { seen.add(MobileEvents["session.rows"].parse(p).id); });
    await r.mac.call("sessions.send", { id: other, text: "hello other" });
    await r.mac.call("sessions.send", { id: open, text: "hello open" });
    await waitFor(() => seen.has(open), { timeout: 5_000 });
    await new Promise((res) => setTimeout(res, 300));
    expect([...seen]).toEqual([open]);
    phone.close();
  });

  it("never lets a terminal's output reach a phone, though the Mac's own windows get every byte", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    await phone.call("session.open", { id });
    const heard: string[] = [];
    phone.on("*", (m) => { heard.push(JSON.stringify(m)); });
    const marker = `TERMINAL-${randomBytes(6).toString("hex")}`;
    const onTheMac = nextEvent(r.mac, "terminal.data", (p) => p.data.includes(marker));
    const { terminalId } = await r.mac.call("terminals.create", { spaceId: r.spaceId });
    await r.mac.call("terminals.write", { terminalId, data: `echo ${marker}\r` });
    await onTheMac;
    // Something the phone does get, after the terminal spoke — so its silence about the terminal is not
    // a dead channel.
    await r.mac.call("sessions.send", { id, text: "hello after the terminal" });
    await phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "user"));
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.filter((h) => h.includes("terminal.data") || h.includes(marker))).toEqual([]);
    await r.mac.call("terminals.close", { terminalId });
    phone.close();
  });

  it("refuses calls that are not mobile.v1, and bad params, by code", async () => {
    const r = await boot();
    const phone = await pairPhone(r);
    await expect(phone.call("sessions.delete", { id: "x" })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(phone.call("terminals.create", { spaceId: r.spaceId })).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(phone.call("remote.pair.start", {})).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(phone.call("session.send", { id: "x" })).rejects.toBeInstanceOf(PhoneCallError);
    await expect(phone.call("session.open", { id: "01JA00000000000000000000ZZ" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(phone.call("session.open", { id: "not-a-ulid" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    phone.close();
  });

  it("drops a phone the moment Settings removes it, and the relay forgets it too", async () => {
    const r = await boot();
    const phone = await pairPhone(r);
    expect(await phone.call("ping")).toMatchObject({ at: expect.any(Number) });
    await r.mac.call("remote.phones.remove", { phoneId: phone.phoneId });
    await expect(phone.call("ping")).rejects.toThrow();
    expect(await status(r)).toMatchObject({ phones: [], state: "off" });
    // Refused by the relay itself (4403), not only by the Mac behind it: the relay has forgotten the
    // phone's key, so a lost phone cannot even reach the Mac's socket to try.
    await expect(phone.connect()).rejects.toThrow(/socket closed 4403/);
    await expect(r.mac.call("remote.phones.remove", { phoneId: phone.phoneId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cuts a removed phone off itself, even through a relay that never heard it was removed", async () => {
    const upstream = await startLocalRelay({ port: 0 });
    const relay = await forgetfulRelay(upstream.url);
    relays.push(relay, upstream);
    const r = await boot({ relay });
    const phone = await pairPhone(r);
    expect(await phone.call("ping")).toMatchObject({ at: expect.any(Number) });
    relay.forget = true;
    await r.mac.call("remote.phones.remove", { phoneId: phone.phoneId });
    // THE mutant: drop the row and tell the relay, but leave the open channel. A relay that did not
    // pass the new list on would then keep a removed phone talking to the Mac.
    await expect(phone.call("ping")).rejects.toThrow();
  });

  it("will not talk to a phone whose relay key is paired but whose Noise key is not", async () => {
    const r = await boot();
    const phone = await pairPhone(r);
    phone.close();
    // Same signing key (the relay lets it in), different X25519 key: the Mac must refuse the handshake.
    const impostor = new TestPhone({ sign: phone.keys.sign, dh: generateDeviceKeys().dh }, phone.mac);
    await expect(impostor.connect()).rejects.toThrow();
  });

  it("pushes a question to a paired phone while nobody is at the Mac, sealed so only that phone can read it", async () => {
    const r = await boot();
    const id = await newSession(r);
    const phone = await pairPhone(r);
    const token = randomBytes(32).toString("hex");
    phone.apns(token);
    // The relay takes one socket's messages in order, so once a ping behind it has come back, it holds
    // the token — and a push will not answer `no-token`.
    await phone.call("ping");
    // Electron is attached but has never said the owner is here: that counts as away, so no hold-back.
    await r.mac.call("sessions.send", { id, text: "ask me something" });
    await waitFor(() => r.pushes.length > 0);
    const [push] = r.pushes;
    expect(push).toMatchObject({ token, macId: phone.mac!.macId, urgent: true, badge: 1 });
    const hs = new HandshakeState({ pattern: "K", initiator: false, prologue: PROLOGUE.push(phone.mac!.macId, phone.phoneId), s: phone.keys.dh, rs: phone.mac!.macKey });
    const sealed = JSON.parse(hs.readMessage(fromB64u(push!.blob)).toString("utf8")) as Record<string, unknown>;
    const title = (await r.mac.call("items.listAll", {})).find((it) => it.refId === id)!.title;
    expect(sealed).toMatchObject({ v: 1, kind: "question", title, body: "Which database?", session: id });
    const [request] = (await r.mac.call("notifications.list", {})).notifications.filter((n) => n.category === "permission");
    expect(push!.collapse).toBe(collapseId("permission", request!.refId!));
    // The relay saw ciphertext: the question is nowhere in what it was handed.
    expect(JSON.stringify(push)).not.toContain("Which database");
    phone.close();
  });

  it("holds a push while the owner is at the Mac: answered there it never goes, left waiting it does", async () => {
    const r = await boot({ pushHoldMs: 400 });
    const id = await newSession(r);
    const phone = await pairPhone(r);
    phone.apns(randomBytes(32).toString("hex"));
    await phone.call("ping");
    await r.mac.call("remote.away", { away: false });
    const asked = () => nextEvent(r.mac, "session.event", (p) => p.sessionId === id && p.event.type === "permission_request");
    const requestId = (p: EventPayload<"session.event">) => (p.event.payload as { requestId: string }).requestId;

    // Answered at the Mac inside the hold: the phone never hears of it.
    let pending = asked();
    await r.mac.call("sessions.send", { id, text: "run it" });
    await r.mac.call("sessions.respondPermission", { id, requestId: requestId(await pending), decision: "allow" });
    await new Promise((res) => setTimeout(res, 800));
    expect(r.pushes.filter((p) => p.urgent)).toEqual([]);

    // Left waiting: it goes when the hold ends, and not before.
    pending = asked();
    await r.mac.call("sessions.send", { id, text: "run it" });
    const second = requestId(await pending);
    expect(r.pushes.filter((p) => p.urgent)).toEqual([]);
    await waitFor(() => r.pushes.some((p) => p.urgent));
    expect(r.pushes.filter((p) => p.urgent).map((p) => p.collapse)).toEqual([collapseId("permission", second)]);
    phone.close();
  });
});

describe("Plan 29's parity: the queue, sub-agents and Review on a paired phone", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const queueOf = (p: unknown, id: string) => {
    const e = MobileEvents["session.queue"].parse(p);
    return e.id === id ? e.queued : undefined;
  };

  it("sends an open session's queue whole each time it changes, and the phone holds, edits, removes and sends what waits", async () => {
    const r = await boot();
    const id = await newSession(r);
    const other = await newSession(r);
    const phone = await pairPhone(r);
    expect(MobileCalls["session.open"].result.parse(await phone.call("session.open", { id })).queued).toEqual([]);
    const queues: unknown[] = [];
    phone.on("session.queue", (p) => { queues.push(p); });
    const running = phone.waitFor("session.status", (p) => { const e = MobileEvents["session.status"].parse(p); return e.id === id && e.status === "running" ? e : undefined; });
    await phone.call("session.send", { id, text: "take your time" });
    await running;

    // THE MUTANT: leave `session.queue` among the broadcasts the gateway drops, and none of these comes.
    let next = phone.waitFor("session.queue", (p) => queueOf(p, id)?.length === 1 ? queueOf(p, id) : undefined);
    await phone.call("session.send", { id, text: "first in line", delivery: "queue" });
    const [first] = await next;
    expect(first).toMatchObject({ text: "first in line", attachments: [], held: false, at: expect.any(Number) });
    next = phone.waitFor("session.queue", (p) => queueOf(p, id)?.length === 2 ? queueOf(p, id) : undefined);
    await phone.call("session.send", { id, text: "with a sketch", delivery: "queue", attachments: [{ name: "sketch.png", mime: "image/png", data: png.toString("base64") }] });
    const [, second] = await next;
    expect(second!.attachments.map((a) => [a.name, a.mime])).toEqual([["sketch.png", "image/png"]]);
    // Its file is one the phone may preview while it waits.
    expect(await phone.call("session.file", { id, path: second!.attachments[0]!.path })).toMatchObject({ name: "sketch.png", preview: { kind: "image" } });

    next = phone.waitFor("session.queue", (p) => queueOf(p, id)?.[0]?.held ? queueOf(p, id) : undefined);
    await phone.call("session.holdQueued", { id, queuedId: first!.id, held: true });
    await next;
    next = phone.waitFor("session.queue", (p) => queueOf(p, id)?.[0]?.text === "first, edited" ? queueOf(p, id) : undefined);
    await phone.call("session.editQueued", { id, queuedId: first!.id, text: "first, edited" });
    expect((await next).map((q) => [q.text, q.held, q.attachments.length])).toEqual([["first, edited", false, 0], ["with a sketch", false, 1]]);
    next = phone.waitFor("session.queue", (p) => queueOf(p, id)?.length === 1 ? queueOf(p, id) : undefined);
    await phone.call("session.removeQueued", { id, queuedId: second!.id });
    expect((await next).map((q) => q.id)).toEqual([first!.id]);
    expect(MobileCalls["session.queue"].result.parse(await phone.call("session.queue", { id })).queued.map((q) => q.text)).toEqual(["first, edited"]);

    // The turn ends and the queue drains into the next one, as the edit left it.
    const sent = phone.waitFor("session.rows", (p) => rowsOf(p, id)?.find((row) => row.kind === "user" && row.text === "first, edited"), 15_000);
    next = phone.waitFor("session.queue", (p) => queueOf(p, id)?.length === 0 ? queueOf(p, id) : undefined, 15_000);
    await next;
    await sent;
    // Too late to hold what has gone out.
    await expect(phone.call("session.holdQueued", { id, queuedId: first!.id, held: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Only the session the phone has open: another's queue never reaches it.
    await r.mac.call("sessions.send", { id: other, text: "take your time" });
    await r.mac.call("sessions.send", { id: other, text: "not for the phone", delivery: "queue" });
    await new Promise((res) => setTimeout(res, 300));
    expect(queues.every((p) => MobileEvents["session.queue"].parse(p).id === id)).toBe(true);
    phone.close();
  });

  it("tells a phone with a lead open that its sub-agents changed, and lists them as its Agents tab does", async () => {
    const r = await boot();
    const lead = await newSession(r);
    const phone = await pairPhone(r);
    await phone.call("session.open", { id: lead });
    const changed = phone.waitFor("session.subagents", (p) => (MobileEvents["session.subagents"].parse(p).id === lead ? true : undefined));
    const { childId } = await r.mac.call("delegation.addTeammate", { sessionId: lead, agentKind: "fake", brief: "Write the migration" });
    // THE MUTANT: leave `delegation.changed` among the broadcasts the gateway drops, and this never comes.
    await changed;
    await waitFor(async () => {
      const { subagents } = MobileCalls["session.subagents"].result.parse(await phone.call("session.subagents", { id: lead }));
      return subagents.length === 1 && subagents[0]!.session.id === childId && subagents[0]!.outcome === "done";
    }, { timeout: 10_000 });
    phone.close();
  });

  it("reads a team's open review on the phone, previews its picture, and decides it through the desktop's Review", async () => {
    const r = await boot();
    const [profile] = await r.mac.call("profiles.list", {});
    const deck = await r.mac.call("spaces.create", { profileId: profile!.id, name: "Deck" });
    mkdirSync(join(deck.folderPath, "renders"), { recursive: true });
    writeFileSync(join(deck.folderPath, "renders", "toggle.png"), png);
    await r.mac.call("team.make", { spaceId: deck.id, templates: [] });
    const role = await r.mac.call("team.roleCreate", { spaceId: deck.id, name: "Content Producer", brief: "Make posts.", realmite: { seed: "cp" }, agentKind: "fake", permissionMode: "acceptEdits" });
    // A card the team's policy draws is the person's to answer, as they would at the Mac.
    r.mac.onEvent((event, payload) => {
      if (event !== "session.event") return;
      const p = payload as EventPayload<"session.event">;
      if (p.event.type === "permission_request") void r.mac.call("sessions.respondPermission", { id: p.sessionId, requestId: p.event.payload.requestId, decision: "allow" }).catch(() => {});
    });
    await r.mac.call("team.roleRun", { id: role.id, message: "send for review" });
    await waitFor(async () => (await r.mac.call("team.space", { spaceId: deck.id })).reviews.length > 0, { timeout: 15_000 });
    const phone = await pairPhone(r);

    const listed = MobileCalls["reviews.list"].result.parse(await phone.call("reviews.list"));
    expect(listed.reviews.map((v) => [v.title, v.state, v.spaceName, v.itemCount, v.roleName])).toEqual([["Dark mode launch", "waiting", "Deck", 2, "Content Producer"]]);
    const id = listed.reviews[0]!.id;
    const detail = MobileCalls["review.get"].result.parse(await phone.call("review.get", { id }));
    expect(detail.items.map((i) => [i.title, i.body, i.channel])).toEqual([[null, "Dark mode is here.", "instagram"], ["It ships Friday", "Hi Dana, it ships Friday.", null]]);
    const [picture] = detail.items[0]!.files;
    expect(picture).toMatchObject({ name: "toggle.png", mime: "image/png" });
    expect(await phone.call("review.file", { id, path: picture!.path })).toMatchObject({ name: "toggle.png", preview: { kind: "image", mime: "image/jpeg" } });
    for (const path of [join(deck.folderPath, "renders"), join(r.home, "realm.db"), "/etc/hosts"]) {
      await expect(phone.call("review.file", { id, path }), path).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    // Asking for changes says what should change; the desktop's Review then shows it sent back, and
    // the phone hears that its work changed.
    await expect(phone.call("review.decide", { id, decision: "changes" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    const work = phone.waitFor("work.changed", () => true);
    const sentBack = MobileCalls["review.decide"].result.parse(await phone.call("review.decide", { id, decision: "changes", note: "Say it ships Friday in the caption too" }));
    expect(sentBack.review).toMatchObject({ id, state: "changes", note: "Say it ships Friday in the caption too" });
    expect(await r.mac.call("team.review", { id })).toMatchObject({ state: "changes", note: "Say it ships Friday in the caption too" });
    await work;
    expect(MobileCalls["review.decide"].result.parse(await phone.call("review.decide", { id, decision: "approve" })).review.state).toBe("approved");
    // A yes already given is not given twice: the Mac's own words say why.
    await expect(phone.call("review.decide", { id, decision: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("approved") });
    expect(MobileCalls["review.decide"].result.parse(await phone.call("review.decide", { id, decision: "reject", note: "Not this week" })).review).toMatchObject({ state: "rejected", note: "Not this week" });
    // Rejected, it has come to rest, and leaves the phone's list of what is open.
    expect(MobileCalls["reviews.list"].result.parse(await phone.call("reviews.list")).reviews).toEqual([]);
    expect((await r.mac.call("team.review", { id })).state).toBe("rejected");
    phone.close();
  });
});

/**
 * A gateway over a fake of the Mac's RPC, for what the real one cannot be made to do on cue: a
 * broadcast at an exact moment of a call, or several in the same instant. A real relay, and a phone
 * paired through it, as everywhere above.
 */
async function fakeMac(lists: Lists, more: Partial<Record<MethodName, (p: never) => unknown>> = {}) {
  const relay = await startLocalRelay({ port: 0 });
  relays.push(relay);
  const home = tempDir("realm-remote-gateway-");
  const store = new FileRemoteStore(home);
  const base = fakeRpc(lists, more);
  const listeners = new Set<(event: EventName, payload: unknown) => void>();
  const rpc: RpcPort = { ...base, onEvent: (l) => { listeners.add(l as never); return () => { listeners.delete(l as never); }; } };
  const gw = new RemoteGateway({
    identity: store.identity(), phones: store, relay: relay.url, rpc, macName: "Test Mac", version: "test", confirm: async () => true,
    reportsDir: join(home, "reports"), realmHome: home,
  });
  gw.start();
  gateways.push(gw);
  await waitFor(() => gw.state === "connected");
  const phone = new TestPhone();
  expect(await phone.pair(gw.openPairing().url)).toEqual({ ok: true });
  await phone.connect();
  const broadcast = <E extends EventName>(event: E, payload: EventPayload<E>) => { for (const l of listeners) l(event, payload); };
  return { phone, broadcast };
}

const gateways: RemoteGateway[] = [];
afterEach(() => { for (const gw of gateways.splice(0)) gw.stop(); });

describe("Plan 29's parity: what a phone hears, at the moment it hears it", () => {
  it("holds a change to the queue that comes while the session opens for the open's answer, and sends every change after", async () => {
    // The open is stopped while it reads the session's history.
    let reached!: () => void;
    const atHistory = new Promise<void>((res) => { reached = res; });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const older = [{ id: "q1", text: "older", attachments: [], ts: 1, held: false }];
    const newer = [...older, { id: "q2", text: "newer", attachments: [], ts: 2, held: false }];
    const { phone, broadcast } = await fakeMac({ sessions: [fakeSession("s1", "s1")], items: [], queued: { s1: older } }, {
      "sessions.events": (async () => { reached(); await gate; return []; }) as never,
    });
    const heard: unknown[] = [];
    phone.on("session.queue", (p) => { heard.push(p); });
    const opening = phone.call("session.open", { id: "s1" });
    await atHistory;
    broadcast("session.queue", { sessionId: "s1", queued: newer });
    release();
    // THE MUTANTS: send the change at once, and it reaches the phone before the session it belongs to
    // has opened; answer with the queue the open read, and the phone opens on one a message behind.
    expect(MobileCalls["session.open"].result.parse(await opening).queued?.map((q) => q.text)).toEqual(["older", "newer"]);
    expect(heard).toEqual([]);
    const emptied = phone.waitFor("session.queue", (p) => (MobileEvents["session.queue"].parse(p).queued.length === 0 ? true : undefined));
    broadcast("session.queue", { sessionId: "s1", queued: [] });
    await emptied;
    phone.close();
  });

  it("says once that a lead's sub-agents changed when a run and a sub-agent's status move together, and for a status alone", async () => {
    const child = fakeSession("child", "s1", { status: "running", dispatchedBy: { sessionId: "lead", kind: "agent_run" } });
    const { phone, broadcast } = await fakeMac({ sessions: [fakeSession("lead", "s1"), child], items: [] }, {
      "delegation.children": ((p: { sessionId: string }) => ({ children: p.sessionId === "lead"
        ? [{ session: child, goal: "Write it", startedAt: 1, settledAt: null, outcome: null, report: null, activity: null }] : [], dismissed: [] })) as never,
      "delegation.running": (() => ({ running: [] })) as never,
    });
    await phone.call("session.open", { id: "lead" });
    await phone.call("session.subagents", { id: "lead" });
    const heard: string[] = [];
    phone.on("session.subagents", (p) => { heard.push(MobileEvents["session.subagents"].parse(p).id); });
    // A settle: the sub-agent goes idle and its lead's runs change in the same instant.
    broadcast("session.status", { sessionId: "child", status: "idle" });
    broadcast("delegation.changed", { sessionId: "lead", running: [] });
    await waitFor(() => heard.length > 0);
    await new Promise((res) => setTimeout(res, 500));
    // THE MUTANT: say each change as it comes, and the phone reads the same list twice.
    expect(heard).toEqual(["lead"]);
    // A sub-agent stopping to ask the person is a change to its lead's list, with no run moving.
    // THE MUTANT: hear only `delegation.changed`, and its row on the phone says it is still working.
    broadcast("session.status", { sessionId: "child", status: "waiting_permission" });
    await waitFor(() => heard.length === 2);
    // Another session's status is not this lead's.
    broadcast("session.status", { sessionId: "someone-else", status: "running" });
    await new Promise((res) => setTimeout(res, 500));
    expect(heard).toEqual(["lead", "lead"]);
    phone.close();
  });

  it("says once that reviews or scheduled tasks changed, however many of their changes come together", async () => {
    const { phone, broadcast } = await fakeMac({ sessions: [], items: [] });
    let heard = 0;
    phone.on("work.changed", () => { heard += 1; });
    broadcast("team.changed", { spaceId: "s1" });
    broadcast("schedules.changed", { spaceId: "s1" });
    broadcast("runs.changed", { spaceId: "s1", run: null });
    broadcast("runs.changed", { spaceId: "s2", run: null });
    await waitFor(() => heard > 0, { timeout: 3_000 });
    await new Promise((res) => setTimeout(res, 1_300));
    // THE MUTANT: say it for each, and a run's every step has the phone read Review and Scheduled again.
    expect(heard).toBe(1);
    phone.close();
  });
});

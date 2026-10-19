import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { REMOTE_RELAY_KEY, sessionEvent, type EventName, type EventPayload } from "@realm/contracts";
import { isSealed } from "@realm/contracts/src/secret-box";
import { fromB64u, generateDeviceKeys, HandshakeState, HomeSchema, MobileCalls, MobileEvents, PROLOGUE, type Row } from "@realm/remote";
import { startLocalRelay, type ApnsPush, type LocalRelay } from "@realm/relay/src/node";
import WebSocket, { WebSocketServer } from "ws";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { REMOTE_IDENTITY_KEY } from "./keys";
import { collapseId } from "./push";
import { loopbackRpc, type RpcPort } from "./rpc-port";
import { remoteSecretBox } from "./secret";
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

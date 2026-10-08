/**
 * Plan 28 Phase 2 — the built server's own Realm Mobile, live (run with: pnpm --filter @realm/server exec tsx scripts/mobile-server-live.ts)
 *
 * Boots the BUILT server on a scratch home (fake agent, so no billed calls), which is the point: the
 * bundle must carry @realm/remote compiled in, and nothing in the suite executes the bundle. Beside it,
 * the relay's core on a local port with a fake APNs. A socket stands in for Electron main — it
 * registers as the browser host and hands over the `remote` key — and a TypeScript phone pairs through
 * Settings' own calls, opens a session, receives a push sealed for it alone, and is removed.
 * Needs `pnpm build` first. Touches only a scratch home; kills only what it started.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_RELAY_KEY, type EventName, type EventPayload } from "@realm/contracts";
import { fromB64u, HandshakeState, PROLOGUE } from "@realm/remote";
import { startLocalRelay, type ApnsPush } from "@realm/relay/src/node";
import { finish, ok } from "./harness";
import { bootServer, removeHome, repoRoot } from "./lib/mobile-rig";
import { loopbackRpc, type RpcPort } from "../src/remote/rpc-port";
import { TestPhone } from "../src/remote/test-phone";

if (!existsSync(join(repoRoot, "apps/server/dist/main.js"))) { console.error("build first: pnpm build"); process.exit(2); }

const until = async (cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};
const next = <E extends EventName>(rpc: RpcPort, event: E, pick: (p: EventPayload<E>) => boolean = () => true): Promise<EventPayload<E>> =>
  new Promise((resolve) => {
    const off = rpc.onEvent((e: EventName, p: unknown) => { if (e === event && pick(p as EventPayload<E>)) { off(); resolve(p as EventPayload<E>); } });
  });

const server = await bootServer();
const pushes: ApnsPush[] = [];
const relay = await startLocalRelay({ port: 0, apns: { send: async (p) => { pushes.push(p); return { ok: true, status: 200, reason: null }; } } });
const phone = new TestPhone();
try {
  const mac = await loopbackRpc({ port: server.port, token: server.token });
  ok("Realm Mobile is locked until Electron main hands over its key", (await mac.call("remote.status", {})).state === "locked");

  // Electron main, as far as the server can tell: it registers, and answers the key ops.
  const key = randomBytes(32).toString("base64");
  mac.onEvent((event, payload) => {
    if (event !== "browserHost.op") return;
    const { callId, op } = payload as EventPayload<"browserHost.op">;
    void mac.call("browserHost.result", { callId, ok: true, result: { key: op === "remoteKey" ? key : null } });
  });
  await mac.call("browserHost.register", { hasWindow: true });
  await until(async () => (await mac.call("remote.status", {})).state === "off");
  ok("with the key it is off: no phone, no window, nothing dialled", true);

  await mac.call("settings.set", { key: REMOTE_RELAY_KEY, value: relay.url });
  const asked = next(mac, "remote.pairRequest");
  const window = await mac.call("remote.pair.start", {});
  const paired = phone.pair(window.url, { name: "Live iPhone", model: "iPhone18,1" });
  const request = await asked;
  ok("the phone that proved the code waits on the owner", request.name === "Live iPhone" && (await mac.call("remote.status", {})).phones.length === 0);
  await mac.call("remote.pair.answer", { requestId: request.requestId, accept: true });
  ok("the owner's yes pairs it", (await paired).ok === true);
  const connected = await phone.connect();
  ok("it connects and the Mac answers by name", connected.mac === (await mac.call("system.info", {})).machineName, connected.mac);

  const [profile] = await mac.call("profiles.list", {});
  const space = await mac.call("spaces.create", { profileId: profile!.id, name: "Live" });
  const { session } = await mac.call("sessions.create", { spaceId: space.id, agentKind: "fake" });
  const opened = await phone.call<{ session: { id: string } }>("session.open", { id: session.id });
  ok("it opens a session through the server's own handlers", opened.session.id === session.id);

  const token = randomBytes(32).toString("hex");
  phone.apns(token);
  await phone.call("ping");
  await mac.call("sessions.send", { id: session.id, text: "ask me something" });
  await until(() => pushes.some((p) => p.urgent));
  const push = pushes.find((p) => p.urgent)!;
  const hs = new HandshakeState({ pattern: "K", initiator: false, prologue: PROLOGUE.push(phone.mac!.macId, phone.phoneId), s: phone.keys.dh, rs: phone.mac!.macKey });
  const sealed = JSON.parse(hs.readMessage(fromB64u(push.blob)).toString("utf8")) as { kind?: string; body?: string; session?: string };
  ok("a question reaches the phone as a push only it can open", sealed.kind === "question" && sealed.session === session.id, sealed.body);
  ok("and the relay was handed no word of it", !JSON.stringify(push).includes(sealed.body ?? "\u0000"));

  await mac.call("remote.phones.remove", { phoneId: phone.phoneId });
  phone.close();
  const refused = await phone.connect().then(() => "connected", (e: Error) => e.message);
  ok("a removed phone is refused by the relay itself", /4403/.test(refused), refused);
  ok("and the Mac stops dialling", (await mac.call("remote.status", {})).state === "off");
  mac.close();
} catch (e) {
  ok("the run completed", false, (e as Error).message);
} finally {
  phone.close();
  await relay.close();
  server.stop();
  // The server takes its SIGTERM a moment to close the database; the scratch home goes after it.
  await new Promise((r) => setTimeout(r, 1_500));
  removeHome(server.home);
}
finish();

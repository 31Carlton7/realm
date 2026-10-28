/**
 * A session's screens on the phone, live (run with: pnpm --filter @realm/server exec tsx scripts/mobile-screens-live.ts)
 *
 * Boots the BUILT server on a scratch home (fake agent, so no billed calls), with the relay's core on a
 * local port and a TypeScript phone paired through Settings' own calls, as mobile-server-live does. A
 * socket stands in for Electron main: it hands over the `remote` key, and answers a `mac` machine's
 * `machineCaptureOnce` with a real picture (`--picture <png>`, a device frame by default) — so the
 * frame goes through the bundle's own `machines.capture`, `MobileApi`, `sips` and the gateway's Noise
 * framing to the phone. No simulator is booted, started or captured: the one listed has a udid no
 * device has. The frame the phone got is written to `--out <jpg>` when given.
 * Needs `pnpm build` first. Touches only a scratch home; kills only what it started.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_RELAY_KEY, type EventName, type EventPayload } from "@realm/contracts";
import type { MobileResult } from "@realm/remote";
import { startLocalRelay } from "@realm/relay/src/node";
import { finish, ok } from "./harness";
import { bootServer, ms, quantile, removeHome, repoRoot } from "./lib/mobile-rig";
import { loopbackRpc, type RpcPort } from "../src/remote/rpc-port";
import { jpegSize } from "../src/remote/screens";
import { PhoneCallError, TestPhone } from "../src/remote/test-phone";

if (!existsSync(join(repoRoot, "apps/server/dist/main.js"))) { console.error("build first: pnpm build"); process.exit(2); }

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const picture = readFileSync(arg("picture") ?? join(repoRoot, "apps/desktop/src/renderer/src/assets/devices/ipad.png"));
const out = arg("out");

const until = async (cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};
const next = <E extends EventName>(rpc: RpcPort, event: E): Promise<EventPayload<E>> =>
  new Promise((resolve) => { const off = rpc.onEvent((e: EventName, p: unknown) => { if (e === event) { off(); resolve(p as EventPayload<E>); } }); });
const refusal = (p: Promise<unknown>): Promise<string> => p.then(() => "answered", (e: Error) => (e instanceof PhoneCallError ? e.code : e.message));
const screenDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("realm-screen-"));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const leftover = screenDirs();
const server = await bootServer();
const relay = await startLocalRelay({ port: 0, apns: { send: async () => ({ ok: true, status: 200, reason: null }) } });
const phone = new TestPhone();
const captures: string[] = [];
try {
  const mac = await loopbackRpc({ port: server.port, token: server.token });
  // Electron main, as far as the server can tell: the key ops, and a mac machine's frame.
  const key = randomBytes(32).toString("base64");
  mac.onEvent((event, payload) => {
    if (event !== "browserHost.op") return;
    const { callId, op, params } = payload as EventPayload<"browserHost.op">;
    if (op === "machineCaptureOnce") {
      captures.push(String(params.bundleId));
      void mac.call("browserHost.result", { callId, ok: true, result: { data: picture.toString("base64"), mimeType: "image/jpeg", width: 800, height: 600 } });
      return;
    }
    void mac.call("browserHost.result", { callId, ok: true, result: { key: op === "remoteKey" ? key : null } });
  });
  await mac.call("browserHost.register", { hasWindow: true });
  await until(async () => (await mac.call("remote.status", {})).state === "off");

  await mac.call("settings.set", { key: REMOTE_RELAY_KEY, value: relay.url });
  const asked = next(mac, "remote.pairRequest");
  const paired = phone.pair((await mac.call("remote.pair.start", {})).url, { name: "Live iPhone", model: "iPhone18,1" });
  await mac.call("remote.pair.answer", { requestId: (await asked).requestId, accept: true });
  ok("the phone pairs", (await paired).ok === true);
  await phone.connect();

  const [profile] = await mac.call("profiles.list", {});
  const space = await mac.call("spaces.create", { profileId: profile!.id, name: "Screens" });
  const other = await mac.call("spaces.create", { profileId: profile!.id, name: "Elsewhere" });
  const { session } = await mac.call("sessions.create", { spaceId: space.id, agentKind: "fake" });
  const before = walk(space.folderPath);
  // A simulator whose udid is no device's, a Mac app started (which is all a `mac` machine's start
  // is), a Mac at an address nobody connected to, and another space's simulator.
  const sim = await mac.call("simulators.create", { spaceId: space.id, name: "iPhone 17 Pro", udid: "00000000-0000-0000-0000-000000000000" });
  const app = await mac.call("machines.create", { spaceId: space.id, name: "TextEdit", source: "mac", endpoint: { transport: "tcp", host: "com.apple.TextEdit", port: 1, path: "/" } });
  await mac.call("machines.start", { machineId: app.machineId });
  const studio = await mac.call("machines.create", { spaceId: space.id, name: "Studio", source: "vnc", endpoint: { transport: "tcp", host: "127.0.0.1", port: 1, path: "/" } });
  const theirs = await mac.call("simulators.create", { spaceId: other.id, name: "iPad Air", udid: null });

  const { screens } = await phone.call<MobileResult<"session.screens">>("session.screens", { id: session.id });
  ok("session.screens lists the space's screens, the live one first, each in words", JSON.stringify(screens) === JSON.stringify([
    { id: app.machineId, kind: "machine", name: "TextEdit", detail: "Mac app", live: true },
    { id: sim.simulatorId, kind: "simulator", name: "iPhone 17 Pro", detail: "iOS Simulator", live: false },
    { id: studio.machineId, kind: "machine", name: "Studio", detail: "Remote screen", live: false },
  ]), JSON.stringify(screens.map((s) => [s.name, s.detail, s.live])));

  const times: number[] = [];
  let frame: MobileResult<"session.screen"> | null = null;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    frame = await phone.call<MobileResult<"session.screen">>("session.screen", { id: session.id, screenId: app.machineId, kind: "machine", maxSide: 1000 });
    times.push(performance.now() - t);
  }
  const jpeg = Buffer.from(frame!.data, "base64");
  const size = jpegSize(jpeg);
  ok("session.screen sends the Mac app's frame as a JPEG through the bundle's own capture", frame!.mime === "image/jpeg" && captures.at(-1) === "com.apple.TextEdit" && size !== null);
  ok("no longer than the side asked for, its size the JPEG's own", size !== null && Math.max(size.width, size.height) <= 1000 && size.width === frame!.width && size.height === frame!.height,
    `${frame!.width}×${frame!.height}`);
  ok("small enough to poll", jpeg.length <= 200 * 1024, `${(jpeg.length / 1024).toFixed(1)} KB from a ${(picture.length / 1024).toFixed(0)} KB capture; p50 ${ms(quantile(times, 0.5))}, max ${ms(Math.max(...times))}`);
  ok("taken just now", Math.abs(Date.now() - frame!.capturedAt) < 10_000);
  if (out) writeFileSync(out, jpeg);

  ok("another space's screen is not found", await refusal(phone.call("session.screen", { id: session.id, screenId: theirs.simulatorId, kind: "simulator" })) === "NOT_FOUND");
  ok("nor is one named as the other kind", await refusal(phone.call("session.screen", { id: session.id, screenId: app.machineId, kind: "simulator" })) === "NOT_FOUND");
  const asks = captures.length;
  ok("a screen that is not live is refused, and nothing is captured", await refusal(phone.call("session.screen", { id: session.id, screenId: sim.simulatorId, kind: "simulator" })) === "FORBIDDEN"
    && await refusal(phone.call("session.screen", { id: session.id, screenId: studio.machineId, kind: "machine" })) === "FORBIDDEN" && captures.length === asks);
  const direct = await mac.call("simulators.capture", { simulatorId: sim.simulatorId }).then(() => "answered", (e: Error & { code?: string }) => e.code ?? e.message);
  ok("the bundle has simulators.capture, which says what simctl said of a device that is not there", direct !== "METHOD_NOT_FOUND", direct);
  ok("nothing was written into the space's folder", JSON.stringify(walk(space.folderPath)) === JSON.stringify(before));
  ok("and no capture was left in the temporary folder", screenDirs().filter((n) => !leftover.includes(n)).length === 0);
  mac.close();
} catch (e) {
  ok("the run completed", false, (e as Error).message);
} finally {
  phone.close();
  await relay.close();
  // The server takes its SIGTERM a moment to close the database; the scratch home goes after it.
  await server.stop();
  removeHome(server.home);
}
finish();

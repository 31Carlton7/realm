/**
 * Plan 28 Phase 1 — the pipe, live (run with: pnpm --filter @realm/server exec tsx scripts/mobile-pipe-live.ts)
 *
 * Stands up the BUILT server on a scratch home (fake agent), the relay's real Worker under `wrangler
 * dev` (or a deployed relay with `--relay wss://…`), a recording tap in front of it, the gateway, and a
 * TypeScript phone that speaks PROTOCOL.md. Then it measures what the spike exists to measure and
 * checks the one property that matters most: a marker string typed into a session reaches the phone,
 * and never crosses the relay in the clear.
 *
 * Flags: --relay <url>  use a deployed relay instead of wrangler dev
 *        --pings <n>    round trips to time (default 100)
 *        --json <path>  also write the numbers there
 * Touches only a scratch home; kills only what it started. Needs `pnpm build` first.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MobileEvents } from "@realm/remote";
import { finish, ok } from "./harness";
import { bootServer, ms, quantile, removeHome, repoRoot, startTap, wranglerDev, type Relay } from "./lib/mobile-rig";
import { RemoteGateway } from "../src/remote/gateway";
import { loopbackRpc } from "../src/remote/rpc-port";
import { TestPhone } from "../src/remote/test-phone";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PINGS = Number(arg("pings") ?? 100);
const MARKER = `MARKER-${randomBytes(6).toString("hex")}`;
const now = (): number => performance.now();
const until = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); }
};

if (!existsSync(join(repoRoot, "apps/server/dist/main.js"))) { console.error("build first: pnpm build"); process.exit(2); }

const server = await bootServer();
let relay: Relay | null = null;
const results: Record<string, unknown> = { at: new Date().toISOString(), marker: MARKER };
try {
  relay = arg("relay") ? { url: arg("relay")!, stop: () => {} } : await wranglerDev();
  results.relay = arg("relay") ?? "wrangler dev (local workerd)";
  const tap = await startTap(relay.url, MARKER);
  const rpc = await loopbackRpc({ port: server.port, token: server.token });
  const gw = new RemoteGateway({ home: server.home, relay: tap.url, rpc, macName: "Live Mac", version: "phase-1", confirm: async () => true, dev: true });
  gw.start();
  await until(() => gw.state === "connected", 20_000);
  ok("the gateway connects to the relay and authenticates", gw.state === "connected");

  // A space and a session with some history, so opening it has something to fold.
  const [profile] = await rpc.call("profiles.list", {});
  const space = await rpc.call("spaces.create", { profileId: profile!.id, name: "Spike" });
  const { session } = await rpc.call("sessions.create", { spaceId: space.id, agentKind: "fake" });
  for (let i = 0; i < 20; i++) await rpc.call("sessions.send", { id: session.id, text: `warm up ${i}` });
  await new Promise((r) => setTimeout(r, 1_500));

  // Pair, then connect five times: the first connect after pairing and four warm ones.
  const phone = new TestPhone();
  const pairStarted = now();
  const paired = await phone.pair(gw.openPairing().url);
  results.pairMs = now() - pairStarted;
  ok("the phone pairs through the relay", paired.ok, JSON.stringify(paired));
  const handshakes: number[] = [];
  for (let i = 0; i < 5; i++) handshakes.push((await phone.connect()).handshakeMs);
  results.handshake = { p50: quantile(handshakes, 0.5), max: Math.max(...handshakes), samples: handshakes };

  // Round trips: phone → relay → Mac → relay → phone.
  const rtts: number[] = [];
  for (let i = 0; i < PINGS; i++) { const t = now(); await phone.call("ping"); rtts.push(now() - t); }
  results.rtt = { p50: quantile(rtts, 0.5), p95: quantile(rtts, 0.95), n: rtts.length };

  const openStarted = now();
  const opened = await phone.call<{ rows: unknown[] }>("session.open", { id: session.id });
  results.openMs = now() - openStarted;
  results.openRows = opened.rows.length;

  // Event latency, one way: when the gateway's process heard the server's event, against when the
  // phone drew it. Same process, same clock, so this is the relay leg and the projection, exactly.
  const heard = new Map<string, number>();
  rpc.onEvent((event, payload) => {
    if (event !== "session.event") return;
    const p = payload as { event: { type: string; payload: { text?: string } } };
    if (p.event.type === "user_message" && p.event.payload.text) heard.set(p.event.payload.text, now());
  });
  const drawn = new Map<string, number>();
  let sawMarkerDecrypted = false;
  phone.on("session.rows", (payload, at) => {
    const e = MobileEvents["session.rows"].parse(payload);
    for (const row of e.rows) {
      if (row.kind === "user" && !drawn.has(row.text)) drawn.set(row.text, at);
      if ((row.kind === "user" || row.kind === "assistant") && row.text.includes(MARKER)) sawMarkerDecrypted = true;
    }
  });
  const oneWay: number[] = [];
  const sendToRow: number[] = [];
  for (let i = 0; i < 20; i++) {
    const text = `latency ${i} ${MARKER}`;
    const t = now();
    await phone.call("session.send", { id: session.id, text });
    await until(() => drawn.has(text) && heard.has(text));
    oneWay.push(drawn.get(text)! - heard.get(text)!);
    sendToRow.push(drawn.get(text)! - t);
  }
  results.eventOneWay = { p50: quantile(oneWay, 0.5), p95: quantile(oneWay, 0.95) };
  results.sendToOwnRow = { p50: quantile(sendToRow, 0.5), p95: quantile(sendToRow, 0.95) };
  ok("the marker reached the phone, decrypted", sawMarkerDecrypted);
  ok("the marker never crossed the relay in the clear", !tap.sawMarker(), `${tap.frames} frames, ${tap.bytes} bytes inspected`);

  // Resume: drop and reconnect, then the first fresh row of the open session.
  phone.close();
  const resumeStarted = now();
  await phone.connect();
  await phone.call("session.open", { id: session.id, limit: 50 });
  results.resumeMs = now() - resumeStarted;

  // The Mac going away cleanly (quit, or its network dropping with a FIN): how soon the phone knows.
  const offline = phone.waitFor("mac", (m) => ((m as { online?: boolean }).online === false ? true : undefined), 30_000);
  const stopAt = now();
  gw.stop();
  await offline;
  results.offlineNoticeMs = now() - stopAt;
  const online = phone.waitFor("mac", (m) => ((m as { online?: boolean }).online === true ? true : undefined), 30_000);
  const startAt = now();
  gw.start();
  await online;
  results.onlineNoticeMs = now() - startAt;
  phone.close();
  gw.stop();
  rpc.close();
  tap.stop();
} catch (e) {
  ok("the run completed", false, (e as Error).message);
} finally {
  relay?.stop();
  server.stop();
  setTimeout(() => removeHome(server.home), 1_000).unref();
}

const r = results as { rtt?: { p50: number; p95: number }; handshake?: { p50: number }; eventOneWay?: { p50: number; p95: number }; sendToOwnRow?: { p50: number; p95: number }; resumeMs?: number; openMs?: number; offlineNoticeMs?: number; onlineNoticeMs?: number };
console.log("\nPlan 28 Phase 1 — the pipe");
console.log(`  relay              ${String(results.relay)}`);
if (r.handshake) console.log(`  handshake          p50 ${ms(r.handshake.p50)}`);
if (r.rtt) console.log(`  round trip         p50 ${ms(r.rtt.p50)}   p95 ${ms(r.rtt.p95)}`);
if (r.eventOneWay) console.log(`  event, one way     p50 ${ms(r.eventOneWay.p50)}   p95 ${ms(r.eventOneWay.p95)}`);
if (r.sendToOwnRow) console.log(`  send → own row     p50 ${ms(r.sendToOwnRow.p50)}   p95 ${ms(r.sendToOwnRow.p95)}`);
if (r.openMs !== undefined) console.log(`  open session       ${ms(r.openMs)} (${String(results.openRows)} rows)`);
if (r.resumeMs !== undefined) console.log(`  resume             ${ms(r.resumeMs)}`);
if (r.offlineNoticeMs !== undefined) console.log(`  Mac gone → phone   ${ms(r.offlineNoticeMs)}`);
if (r.onlineNoticeMs !== undefined) console.log(`  Mac back → phone   ${ms(r.onlineNoticeMs)}`);
const out = arg("json");
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(results, null, 1)); }
finish();

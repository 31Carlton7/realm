/**
 * Plan 28 Phase 1 — the iPhone app in the Simulator, live (run with: pnpm --filter @realm/server exec tsx scripts/mobile-sim-live.ts)
 *
 * The same rig as mobile-pipe-live (BUILT server, fake agent, the relay's Worker under wrangler dev,
 * the gateway), but the phone is the real app: built with xcodebuild, installed on the iPhone 17
 * Simulator, launched with `-pairLink <url> -autoDiagnostics 1`. The app pairs, connects, runs its
 * diagnostics and posts them back with `debug.report`; this script waits for that report, prints it,
 * and keeps a screenshot. The Simulator shares this Mac's network, so the loopback relay is reachable.
 *
 * Flags: --udid <id> (default the iPhone 17 Simulator) · --skip-build · --relay <url>
 * Uses the iPhone 17 Simulator only — never the booted iPhone 17 Pro another session drives.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { finish, ok } from "./harness";
import { bootServer, removeHome, repoRoot, scratchGateway, wranglerDev, type Relay } from "./lib/mobile-rig";
import { loopbackRpc } from "../src/remote/rpc-port";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const UDID = arg("udid") ?? "CDA45F4D-4FDD-40A9-8259-D58BE3BEF20C";
const BUNDLE = "co.charmtechnologies.realm.ios";
const ios = join(repoRoot, "apps/ios");
const derived = join(ios, ".build/DerivedData");
const results = join(homedir(), "Desktop/Home/Work/Projects/realm-scratch/mobile/results");
const run = (cmd: string, args: string[], cwd = ios) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();

if (!process.argv.includes("--skip-build")) {
  run("xcodegen", ["generate"]);
  run("xcodebuild", ["-project", "Realm.xcodeproj", "-scheme", "Realm", "-destination", `id=${UDID}`, "-derivedDataPath", derived, "build"]);
}
const app = join(derived, "Build/Products/Debug-iphonesimulator/Realm.app");
ok("the app built", existsSync(app), app);

const server = await bootServer();
let relay: Relay | null = null;
try {
  relay = arg("relay") ? { url: arg("relay")!, stop: () => {} } : await wranglerDev();
  const rpc = await loopbackRpc({ port: server.port, token: server.token });
  const gw = scratchGateway({ home: server.home, relay: relay.url, rpc, macName: "Sim Mac", version: "phase-1", confirm: async () => true, dev: true });
  gw.start();
  const [profile] = await rpc.call("profiles.list", {});
  const space = await rpc.call("spaces.create", { profileId: profile!.id, name: "Spike" });
  const { session } = await rpc.call("sessions.create", { spaceId: space.id, agentKind: "fake" });
  await rpc.call("sessions.send", { id: session.id, text: "Hello from the Mac" });
  for (let i = 0; i < 50 && gw.state !== "connected"; i++) await new Promise((r) => setTimeout(r, 100));

  try { run("xcrun", ["simctl", "boot", UDID]); } catch { /* already booted */ }
  run("xcrun", ["simctl", "bootstatus", UDID, "-b"]);
  try { run("xcrun", ["simctl", "uninstall", UDID, BUNDLE]); } catch { /* not installed */ }
  run("xcrun", ["simctl", "install", UDID, app]);
  const { url } = gw.openPairing();
  run("xcrun", ["simctl", "launch", "--terminate-running-process", UDID, BUNDLE, "-pairLink", url, "-autoDiagnostics", "1"]);

  const reports = join(server.home, "remote", "reports");
  const deadline = Date.now() + 120_000;
  let report: unknown = null;
  while (Date.now() < deadline && !report) {
    if (existsSync(reports)) {
      const f = readdirSync(reports).find((n) => n.endsWith(".json"));
      if (f) report = JSON.parse(readFileSync(join(reports, f), "utf8"));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  ok("the app paired", gw.devices().length === 1, gw.devices().map((d) => d.name).join(", "));
  ok("the app ran its diagnostics and reported them", report !== null);
  if (report) console.log(JSON.stringify(report, null, 1));
  mkdirSync(results, { recursive: true });
  const shot = join(results, `sim-${Date.now()}.png`);
  run("xcrun", ["simctl", "io", UDID, "screenshot", shot]);
  console.log(`screenshot: ${shot}`);
  gw.stop();
  rpc.close();
} catch (e) {
  ok("the run completed", false, (e as Error).message);
} finally {
  try { run("xcrun", ["simctl", "shutdown", UDID]); } catch { /* fine */ }
  relay?.stop();
  server.stop();
  setTimeout(() => removeHome(server.home), 1_000).unref();
}
finish();

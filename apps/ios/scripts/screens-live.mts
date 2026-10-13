/**
 * Plan 28 Phase 2 — a Mac for the iPhone app's screens, staged (run with:
 *   pnpm --filter @realm/server exec tsx ../ios/scripts/screens-live.mts)
 *
 * Boots the BUILT server on a scratch home with the scripted agent standing in for Claude and Codex
 * (no billed turn), the relay's real Worker under `wrangler dev` on a fixed port, and the gateway.
 * Stages spaces and sessions in the states the app draws — a permission waiting, questions, a plan,
 * Markdown prose, an error with its fix, a turn that changed files under git and made a picture, more
 * sessions than Home lists — then prints one JSON line,
 * `{"pairLink", "sessions": {...}}`, and takes commands on stdin:
 *
 *   sleep        the Mac goes quiet: the gateway stops, and the relay tells the phone it is offline
 *   wake         it comes back
 *   relay-down   the relay stops: the phone cannot reach it
 *   relay-up     the relay comes back on the same port
 *   pair         a new pairing link
 *   send <key> <text>   a message to a staged session, from the Mac
 *   quit
 *
 * With --ui it drives the app itself instead: it builds the RealmLive scheme's UI tests once, then
 * runs one test per phase on the iPhone 17 Simulator — pair (the Mac holds its answer a few seconds),
 * awake, asleep, awake again, the relay down, then the largest text size and Reduce Transparency with
 * everything back up — moving the Mac between them, and leaves each test's
 * screenshots in apps/ios/.build/screenshots (--shots <dir> to change it). It exits non-zero if any
 * phase fails. --phases test0_forgetThenPair,test1_awake runs only those; --udid <id> picks the
 * Simulator, --derived-data <dir> where xcodebuild builds (apps/ios/.build/DerivedData), and
 * --no-build runs what was built there last.
 *
 * Never the owner's ~/Realm: the scratch home is made fresh and removed on quit.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { bootServer, freePort, removeHome, repoRoot, scratchGateway } from "../../server/scripts/lib/mobile-rig";
import { loopbackRpc } from "../../server/src/remote/rpc-port";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const say = (line: string) => process.stderr.write(`${line}\n`);

/** The relay's Worker on loopback, on a port that survives a restart, so a paired phone finds it again. */
function relayOn(port: number): { url: string; stop(): Promise<void>; ready: Promise<void> } {
  const child: ChildProcess = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"], {
    cwd: join(repoRoot, "services/relay"), env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  child.stdout!.on("data", (b: Buffer) => { log += b.toString(); });
  child.stderr!.on("data", (b: Buffer) => { log += b.toString(); });
  const ready = (async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log.slice(-2_000)}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`wrangler dev never answered /health:\n${log.slice(-2_000)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  return {
    url: `ws://127.0.0.1:${port}`, ready,
    stop: async () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ }
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100));
    },
  };
}

process.env.REALM_FAKE_STANDS_IN = "claude,codex";
const server = await bootServer();
const port = Number(arg("relay-port") ?? (await freePort()));
let relay = relayOn(port);
await relay.ready;
const rpc = await loopbackRpc({ port: server.port, token: server.token });
const ui = process.argv.includes("--ui");
// In UI runs the Mac holds its answer long enough for the phone to be seen asking for it.
const confirmMs = Number(arg("confirm-ms") ?? (ui ? 6_000 : 0));
const gw = scratchGateway({
  home: server.home, relay: relay.url, rpc, macName: arg("mac") ?? "MacBook Pro", version: "2.0.3", dev: true,
  confirm: async () => { await new Promise((r) => setTimeout(r, confirmMs)); return true; },
});
gw.start();

const waitFor = async (what: string, ok: () => Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ok()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what}`);
};
const status = async (id: string) => (await rpc.call("sessions.get", { id })).status;
const settled = (id: string) => waitFor(`${id} to settle`, async () => ["idle", "waiting_permission", "error"].includes(await status(id)));

const [profile] = await rpc.call("profiles.list", {});
const space = (name: string, icon: string, color: string) => rpc.call("spaces.create", { profileId: profile!.id, name, icon, color });
const realm = await space("Realm", "emoji:🌊", "#3b82f6");
// Site wears one of the picker's glyphs rather than an emoji, so the glyph is drawn in its colour.
const site = await space("Site", "browser", "#10b981");
const laya = await space("Laya", "emoji:🦜", "#f59e0b");

const session = async (spaceId: string, agentKind: "claude" | "codex", model: string, title: string) =>
  (await rpc.call("sessions.create", { spaceId, agentKind, model, title })).session.id;
const send = async (id: string, text: string) => { await rpc.call("sessions.send", { id, text }); await new Promise((r) => setTimeout(r, 300)); await settled(id); };

const MARKDOWN = [
  "",
  "## How the relay works",
  "",
  "The Mac **dials out** to the relay and keeps one socket open, so nothing listens on its network. Each phone gets a channel of its own, and every frame on it is *ciphertext* the relay cannot read.",
  "",
  "1. The phone signs the relay's challenge.",
  "2. It runs `Noise_IK` with the Mac, one round trip.",
  "3. From then on it speaks `mobile.v1`.",
  "",
  "> A sleeping Mac is announced: once its heartbeat is a minute old, the relay tells the phone.",
  "",
  "```ts",
  "const link = encodeLink({ relay, macId, macKey, secret, windowId });",
  "```",
  "",
  "| Measure | Wi-Fi | Cellular |",
  "|:--|--:|--:|",
  "| Handshake | 101 ms | 157 ms |",
  "| Round trip p95 | 169 ms | 403 ms |",
  "",
  "- [x] Pushes decrypt on the device",
  "- [ ] Live Activities",
  "",
  "See [the protocol](https://realm.computer/docs/mobile) for the rest.",
].join("\n");

const sessions: Record<string, string> = {};
// Idle sessions first, so the staged ones below are the newest and Home lists them; with these the
// Realm space has more sessions than Home shows.
for (const [title, text] of [["Fix the flaky upload test", "Run the upload tests again"], ["Tidy the settings page", "Tighten the spacing"], ["Ship 2.0.3", "Write the release notes"], ["Audit the sign-in sheet", "Check the copy"]] as const) {
  const id = await session(realm.id, "claude", "claude-opus-5-5", title);
  await send(id, text);
  sessions[title] = id;
}
// An error with its fix, prose, a plan.
sessions.error = await session(laya.id, "codex", "gpt-6-astra", "Train the social model");
await send(sessions.error, "hit the limit");
sessions.markdown = await session(realm.id, "claude", "claude-sonnet-5", "Explain the relay");
await send(sessions.markdown, MARKDOWN);
// A turn that really edits two files of the space's checkout, and leaves a picture behind: the Mac
// records the edits as the turn's changes (it needs git) and the picture as a file made. The scripted
// turn ("fix the org access") edits the two files transcript-live.mjs seeds, so they are seeded here
// the same way; anywhere else its edits fail, as a real edit would.
{
  const folder = (realm as { folderPath: string }).folderPath;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Realm", "-c", "user.email=staging@realm.computer", "-c", "commit.gpgsign=false", ...args], { cwd: folder, stdio: "pipe" });
  const helpers = (n: number, stem: string) => Array.from({ length: n }, (_, i) => [
    `export function ${stem}${i}(name: string): string {`, `  return name.trim().toLowerCase().replace(/\\s+/g, "-${i}");`, "}", "",
  ]).flat();
  const orgs = [
    'import { and, eq } from "drizzle-orm";', 'import { db } from "./db";', 'import { organizationMember, withInviteDefaults } from "./schema";', "",
    ...helpers(19, "orgSlug"),
    "/** The caller's membership in an organisation, or null. */",
    "export async function getOrgMembership(orgId: string, userId: string) {",
    "  const rows = await db.select().from(organizationMember)",
    "    .where(and(eq(organizationMember.organizationId, orgId), eq(organizationMember.userId, userId)));",
    "  return rows[0] ?? null;", "}", "", ...helpers(6, "orgLabel"),
  ];
  const compact = [...helpers(16, "chunkName"), "", "", "export function shouldCompact(tokens: number, limit: number) {", "  return tokens > limit * 0.85;", "}", ""];
  mkdirSync(join(folder, "web/lib/agent/chat-runtime/compaction"), { recursive: true });
  writeFileSync(join(folder, "web/lib/orgs.ts"), `${orgs.join("\n")}\n`);
  writeFileSync(join(folder, "web/lib/agent/chat-runtime/compaction/auto-compact.ts"), `${compact.join("\n")}\n`);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "Start");
  sessions.changes = await session(realm.id, "claude", "claude-opus-5-5", "Fix the org access crash");
  await rpc.call("sessions.send", { id: sessions.changes, text: "fix the org access crash on the connections page" });
  // The page, as the turn left it: a picture made while the turn ran.
  mkdirSync(join(folder, "renders"), { recursive: true });
  execFileSync("sips", ["-s", "format", "png", join(repoRoot, "site/public/product/connections-1440.webp"), "--out", join(folder, "renders/connections-page.png")], { stdio: "pipe" });
  await settled(sessions.changes);
  if (!readFileSync(join(folder, "web/lib/orgs.ts"), "utf8").includes("withInviteDefaults(row)")) say("warning: the staged turn did not edit web/lib/orgs.ts");
}
sessions.plan = await session(realm.id, "claude", "claude-opus-5-5", "Rework the transcript mapper");
await send(sessions.plan, "Make a plan for the mapper");
// Needs you: questions, then a permission.
sessions.question = await session(site.id, "codex", "gpt-6-luna", "Choose the database for sign-ups");
await send(sessions.question, "ask me");
sessions.permission = await session(realm.id, "claude", "claude-opus-5-5", "Add the dark-mode toggle");
await send(sessions.permission, "Build the dark-mode toggle");
// Read up to its first event, then moved on: unread.
const plan = await rpc.call("sessions.events", { id: sessions.plan, afterSeq: 0, limit: 1 });
if (plan[0]) await rpc.call("sessions.markSeen", { id: sessions.plan, seq: plan[0].seq });
await send(sessions.plan, "Carry on");

await waitFor("the relay link", async () => gw.state === "connected");
let pairing = gw.openPairing();
console.log(JSON.stringify({ pairLink: pairing.url, relay: relay.url, home: server.home, sessions }));
say(`staged on ${server.home}; relay ${relay.url}. Commands: sleep · wake · relay-down · relay-up · pair · send <key> <text> · quit`);

/** One `xcrun simctl` call; resolves to its exit code. */
const simctl = (args: string[]): Promise<number> => new Promise((done) => {
  spawn("xcrun", ["simctl", ...args], { stdio: "ignore" }).on("exit", (code) => done(code ?? 1));
});

/** One xcodebuild, its output passed through; resolves to its exit code. Never spawnSync: the
 *  gateway in this process answers the phone while the test runs. */
const xcodebuild = (args: string[], env: Record<string, string> = {}): Promise<number> => new Promise((done) => {
  const child = spawn("xcodebuild", args, { cwd: join(repoRoot, "apps/ios"), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const keep = (b: Buffer) => { for (const line of b.toString().split("\n")) if (/(Test Case|error:|failed|passed|\*\* TEST)/.test(line)) say(line.trim()); };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  child.on("exit", (code) => done(code ?? 1));
});

async function runUiTests(): Promise<boolean> {
  const udid = arg("udid") ?? "CDA45F4D-4FDD-40A9-8259-D58BE3BEF20C";
  const shots = arg("shots") ?? join(repoRoot, "apps/ios/.build/screenshots");
  mkdirSync(shots, { recursive: true });
  const common = ["-project", "Realm.xcodeproj", "-scheme", "RealmLive", "-destination", `id=${udid}`, "-derivedDataPath", arg("derived-data") ?? ".build/DerivedData"];
  if (!process.argv.includes("--no-build") && await xcodebuild(["build-for-testing", ...common]) !== 0) { say("the UI tests did not build"); return false; }
  const results: [string, boolean][] = [];
  const only = arg("phases")?.split(",");
  const phase = async (test: string, env: Record<string, string> = {}) => {
    if (only && !only.includes(test)) return;
    say(`— ${test}`);
    const code = await xcodebuild(["test-without-building", ...common, `-only-testing:RealmUITests/LiveTests/${test}`],
      { TEST_RUNNER_SHOTS: shots, ...env });
    results.push([test, code === 0]);
  };
  await phase("test0_forgetThenPair", { TEST_RUNNER_PAIR_LINK: gw.openPairing().url });
  await phase("test1_awake");
  gw.stop();
  await phase("test2_asleep");
  gw.start();
  await waitFor("the relay link", async () => gw.state === "connected");
  await phase("test3_awakeAgain");
  await relay.stop();
  await phase("test4_relayDown");
  relay = relayOn(port);
  await relay.ready;
  await waitFor("the relay link", async () => gw.state === "connected", 90_000);
  await phase("test5_largestText");
  // Reduce Transparency has no simctl switch; the app reads it from the accessibility domain at launch.
  const reduceTransparency = (on: boolean) =>
    simctl(["spawn", udid, "defaults", "write", "com.apple.Accessibility", "EnhancedBackgroundContrastEnabled", "-bool", String(on)]);
  await reduceTransparency(true);
  await phase("test6_reduceTransparency");
  await reduceTransparency(false);
  for (const [test, passed] of results) say(`${passed ? "passed" : "FAILED"}  ${test}`);
  say(`screenshots in ${shots}`);
  return results.every(([, passed]) => passed);
}

let quitting = false;
const shutdown = async () => {
  if (quitting) return;
  quitting = true;
  gw.stop();
  rpc.close();
  await relay.stop();
  server.stop();
  setTimeout(() => { removeHome(server.home); process.exit(process.exitCode ?? 0); }, 1_000);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

/** Commands on stdin, until quit. */
function interactive(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const [cmd, key, ...rest] = line.trim().split(/\s+/);
    try {
      if (cmd === "sleep") { gw.stop(); say("asleep"); }
      else if (cmd === "wake") { gw.start(); await waitFor("the relay link", async () => gw.state === "connected"); say("awake"); }
      else if (cmd === "relay-down") { await relay.stop(); say("relay down"); }
      else if (cmd === "relay-up") { relay = relayOn(port); await relay.ready; say("relay up"); }
      else if (cmd === "pair") { pairing = gw.openPairing(); console.log(JSON.stringify({ pairLink: pairing.url })); }
      else if (cmd === "send") { await rpc.call("sessions.send", { id: sessions[key ?? ""] ?? key ?? "", text: rest.join(" ") }); say("sent"); }
      else if (cmd === "quit") { await shutdown(); }
      else if (cmd) say("commands: sleep · wake · relay-down · relay-up · pair · send <key> <text> · quit");
    } catch (e) {
      say(`error: ${(e as Error).message}`);
    }
  });
  rl.on("close", () => void shutdown());
}

if (ui) {
  const passed = await runUiTests();
  process.exitCode = passed ? 0 : 1;
  await shutdown();
} else {
  interactive();
}

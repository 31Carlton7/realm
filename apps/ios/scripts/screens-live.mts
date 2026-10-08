/**
 * Plan 28 Phase 2 — a Mac for the iPhone app's screens, staged (run with:
 *   pnpm --filter @realm/server exec tsx ../ios/scripts/screens-live.mts)
 *
 * Boots the BUILT server on a scratch home with the scripted agent standing in for Claude and Codex
 * (no billed turn), the relay's real Worker under `wrangler dev` on a fixed port, and the gateway.
 * Stages spaces and sessions in the states the app draws — a permission waiting, questions, a plan,
 * Markdown prose, an error with its fix, more sessions than Home lists — then prints one JSON line,
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
 * Never the owner's ~/Realm: the scratch home is made fresh and removed on quit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { bootServer, freePort, removeHome, repoRoot } from "../../server/scripts/lib/mobile-rig";
import { RemoteGateway } from "../../server/src/remote/gateway";
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
const gw = new RemoteGateway({ home: server.home, relay: relay.url, rpc, macName: arg("mac") ?? "MacBook Pro", version: "2.0.3", confirm: async () => true, dev: true });
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
const site = await space("Site", "emoji:🧭", "#10b981");
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
// Needs you: a permission, then questions.
sessions.permission = await session(realm.id, "claude", "claude-opus-5-5", "Add the dark-mode toggle");
await send(sessions.permission, "Build the dark-mode toggle");
sessions.question = await session(site.id, "codex", "gpt-6-luna", "Choose the database for sign-ups");
await send(sessions.question, "ask me");
// A plan, prose, an error with its fix.
sessions.plan = await session(realm.id, "claude", "claude-opus-5-5", "Rework the transcript mapper");
await send(sessions.plan, "Make a plan for the mapper");
sessions.markdown = await session(realm.id, "claude", "claude-sonnet-5", "Explain the relay");
await send(sessions.markdown, MARKDOWN);
sessions.error = await session(laya.id, "codex", "gpt-6-astra", "Train the social model");
await send(sessions.error, "hit the limit");
// Enough idle sessions that a space has more than Home lists.
for (const [title, text] of [["Fix the flaky upload test", "Run the upload tests again"], ["Tidy the settings page", "Tighten the spacing"], ["Ship 2.0.3", "Write the release notes"], ["Audit the sign-in sheet", "Check the copy"]] as const) {
  const id = await session(realm.id, "claude", "claude-opus-5-5", title);
  await send(id, text);
  sessions[title] = id;
}
// Read up to its first event, then moved on: unread.
const plan = await rpc.call("sessions.events", { id: sessions.plan, afterSeq: 0, limit: 1 });
if (plan[0]) await rpc.call("sessions.markSeen", { id: sessions.plan, seq: plan[0].seq });
await send(sessions.plan, "Carry on");
// The permission's session last, so it is the newest in its space.
await rpc.call("sessions.get", { id: sessions.permission });

await waitFor("the relay link", async () => gw.state === "connected");
let pairing = gw.openPairing();
console.log(JSON.stringify({ pairLink: pairing.url, relay: relay.url, home: server.home, sessions }));
say(`staged on ${server.home}; relay ${relay.url}. Commands: sleep · wake · relay-down · relay-up · pair · send <key> <text> · quit`);

let quitting = false;
const shutdown = async () => {
  if (quitting) return;
  quitting = true;
  gw.stop();
  rpc.close();
  await relay.stop();
  server.stop();
  setTimeout(() => { removeHome(server.home); process.exit(0); }, 1_000);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

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

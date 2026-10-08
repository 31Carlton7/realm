/**
 * Plan 28 Phase 1 — a Mac for a real iPhone to talk to (run with: pnpm --filter @realm/server exec tsx scripts/mobile-sidecar.ts)
 *
 * Boots the BUILT server (fake agent) on a persistent scratch home — so a pairing survives restarts
 * while the phone is being tried — and runs the gateway beside it, against `wrangler dev` or a
 * deployed relay. Never the owner's ~/Realm: the spike keeps its keys in a plain file.
 *
 * Flags: --home <dir>   scratch home (default realm-scratch/mobile/home)
 *        --relay <url>  a deployed relay; without it, wrangler dev on loopback (Simulator only)
 *        --yes          pair without asking
 *        --no-qr        print the pairing link only (for scripts; no QR opened in Preview)
 * Commands on stdin: pair · devices · push <phoneId|all> [kind] · revoke <phoneId> · send <text> · quit
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bootServer, repoRoot, wranglerDev, type Relay } from "./lib/mobile-rig";
import { RemoteGateway, type PushPayload } from "../src/remote/gateway";
import { loopbackRpc } from "../src/remote/rpc-port";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const home = arg("home") ?? join(homedir(), "Desktop/Home/Work/Projects/realm-scratch/mobile/home");
mkdirSync(home, { recursive: true });

const server = await bootServer({ home });
const relay: Relay = arg("relay") ? { url: arg("relay")!, stop: () => {} } : await wranglerDev();
const rpc = await loopbackRpc({ port: server.port, token: server.token });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

const gw = new RemoteGateway({
  home, relay: relay.url, rpc, macName: "Spike Mac", version: "phase-1", dev: true, log: (l) => console.log(l),
  confirm: async ({ name, model }) => process.argv.includes("--yes") || /^y/i.test(await ask(`\nPair "${name}" (${model})? [y/N] `)),
});
gw.onState((s) => console.log(`[relay] ${s}`));
gw.start();

// One space and one session to look at, made on the first run only.
const spaces = await rpc.call("spaces.list", {});
let sessionId = (await rpc.call("sessions.listAll", { profileId: null }))[0]?.id;
if (!sessionId) {
  const [profile] = await rpc.call("profiles.list", {});
  const space = spaces[0] ?? await rpc.call("spaces.create", { profileId: profile!.id, name: "Spike" });
  sessionId = (await rpc.call("sessions.create", { spaceId: space.id, agentKind: "fake" })).session.id;
  await rpc.call("sessions.send", { id: sessionId, text: "Hello from the Mac" });
}
console.log(`home ${home}\nrelay ${relay.url}\nsession ${sessionId}\nType: pair · devices · push <phoneId|all> [kind] · revoke <phoneId> · send <text> · quit`);

const shutdown = () => { gw.stop(); rpc.close(); relay.stop(); server.stop(); rl.close(); setTimeout(() => process.exit(0), 500); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

rl.on("line", async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    if (cmd === "pair") {
      const { url, expiresAt } = gw.openPairing();
      console.log(`pairing link (until ${new Date(expiresAt).toLocaleTimeString()}):\n${url}`);
      if (!process.argv.includes("--no-qr")) {
        const png = join(home, "remote", "pair.png");
        execFileSync("swift", [join(repoRoot, "apps/server/scripts/lib/qr.swift"), url, png]);
        execFileSync("open", [png]);
        console.log(`QR code: ${png}`);
      }
    } else if (cmd === "devices") {
      for (const d of gw.devices()) console.log(`${d.phoneId}  ${d.name}  ${d.model}  last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "never"}`);
    } else if (cmd === "push") {
      const targets = rest[0] === "all" ? gw.devices().map((d) => d.phoneId) : [rest[0] ?? ""];
      const p: PushPayload = { kind: (rest[1] as PushPayload["kind"]) ?? "test", title: "Fix the flaky test", body: "Wants to run `pnpm test`", session: sessionId ?? null };
      for (const id of targets) console.log(id, await gw.push(id, p, { urgent: p.kind === "permission" || p.kind === "question" }));
    } else if (cmd === "revoke") {
      console.log(gw.revoke(rest[0] ?? "") ? "removed" : "no such phone");
    } else if (cmd === "send") {
      await rpc.call("sessions.send", { id: sessionId!, text: rest.join(" ") || "ping from the Mac" });
    } else if (cmd === "quit") {
      shutdown();
    } else if (cmd) {
      console.log("commands: pair · devices · push <phoneId|all> [kind] · revoke <phoneId> · send <text> · quit");
    }
  } catch (e) {
    console.log(`error: ${(e as Error).message}`);
  }
});

/**
 * Plan 28 — what a phone sees when its Mac goes quiet without closing its connection
 * (run with: pnpm --filter @realm/server exec tsx scripts/mobile-quiet-mac-live.ts --relay wss://…)
 *
 * A sleeping Mac, or one whose network was pulled, sends no close; its socket just stops. This runs the
 * sidecar as a child process on a scratch home, pairs a TypeScript phone with it, then SIGSTOPs the
 * sidecar — the gateway freezes with its socket open, as in sleep — and times how long until the phone
 * is told the Mac is offline, and what a request does meanwhile. Then SIGCONT: how soon the phone is
 * told the Mac is back, and the recovery. Phase 1 found no notice within 180 s; PROTOCOL.md §3.2 now
 * promises one 60 s after the Mac's last message or heartbeat.
 *
 * Flags: --relay <url> (required) · --wait <seconds> to wait for an offline notice (default 180)
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finish, ok } from "./harness";
import { removeHome, repoRoot } from "./lib/mobile-rig";
import { TestPhone } from "../src/remote/test-phone";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const relay = arg("relay");
if (!relay) { console.error("--relay is required"); process.exit(2); }
const WAIT = Number(arg("wait") ?? 180) * 1000;
const home = mkdtempSync(join(tmpdir(), "realm-quiet-mac-"));
const now = (): number => performance.now();

const sidecar = spawn(process.execPath, ["--import", "tsx", "scripts/mobile-sidecar.ts", "--relay", relay, "--home", home, "--yes", "--no-qr"], {
  cwd: join(repoRoot, "apps/server"), stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
sidecar.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
sidecar.stderr!.on("data", () => {});
const waitFor = async (re: RegExp, ms: number): Promise<RegExpMatchArray> => {
  const end = Date.now() + ms;
  for (;;) {
    const m = out.match(re);
    if (m) return m;
    if (Date.now() > end) throw new Error(`timed out waiting for ${re}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

const results: Record<string, unknown> = { relay };
const phone = new TestPhone();
try {
  await waitFor(/\[relay\] connected/, 60_000);
  sidecar.stdin!.write("pair\n");
  const [link] = await waitFor(/https:\/\/realm\.computer\/pair#\S+/, 20_000);
  ok("the phone pairs with the sidecar", (await phone.pair(link!)).ok);
  await phone.connect();
  ok("a request answers while the Mac is awake", typeof (await phone.call<{ at: number }>("ping")).at === "number");

  // Freeze the gateway with its socket open: no close, no heartbeat, nothing — the relay's view of sleep.
  const offline = phone.waitFor("mac", (m) => ((m as { online?: boolean }).online === false ? true : undefined), WAIT).then(() => now()).catch(() => null);
  const frozeAt = now();
  process.kill(sidecar.pid!, "SIGSTOP");
  const reply = await withTimeout(phone.call("ping"), 15_000);
  results.requestWhileQuiet = reply === "timeout" ? "no answer within 15 s" : "answered";
  ok("a request to a quiet Mac gets no answer (it waits on a socket nobody reads)", reply === "timeout");
  const noticedAt = await offline;
  results.offlineNoticeMs = noticedAt === null ? null : Math.round(noticedAt - frozeAt);
  console.log(noticedAt === null ? `  the phone was NOT told the Mac went quiet within ${WAIT / 1000} s` : `  the phone was told after ${Math.round((noticedAt - frozeAt) / 1000)} s`);
  // The Mac's last heartbeat can be up to 20 s before the freeze, and the relay's alarm may run late.
  ok("the phone is told the Mac went quiet, 40–80 s after it froze", noticedAt !== null && noticedAt - frozeAt >= 40_000 && noticedAt - frozeAt <= 80_000);

  // Wake it. Its socket may have been dropped meanwhile; either way the gateway carries on or reconnects.
  const back = phone.waitFor("mac", (m) => ((m as { online?: boolean }).online === true ? true : undefined), 40_000).then(() => now()).catch(() => null);
  const wokeAt = now();
  process.kill(sidecar.pid!, "SIGCONT");
  const backAt = await back;
  results.onlineNoticeMs = backAt === null ? null : Math.round(backAt - wokeAt);
  ok("the phone is told the Mac is back once it wakes", backAt !== null, backAt === null ? "" : `${Math.round(backAt - wokeAt)} ms`);
  await waitFor(/\[relay\] connected[\s\S]*$/, 5_000).catch(() => null);
  let recovered: number | null = null;
  for (let i = 0; i < 60 && recovered === null; i++) {
    try {
      phone.close();
      await phone.connect();
      if ((await withTimeout(phone.call("ping"), 5_000)) !== "timeout") recovered = now() - wokeAt;
    } catch { await new Promise((r) => setTimeout(r, 1_000)); }
  }
  results.recoveryMs = recovered === null ? null : Math.round(recovered);
  ok("the phone reaches the Mac again once it wakes", recovered !== null, recovered === null ? "" : `${Math.round(recovered)} ms`);
} catch (e) {
  ok("the run completed", false, (e as Error).message);
} finally {
  phone.close();
  try { process.kill(sidecar.pid!, "SIGCONT"); } catch { /* gone */ }
  sidecar.stdin!.write("quit\n");
  // The home goes only once the sidecar, and the server it stops on the way out, have let go of it.
  const exited = sidecar.exitCode !== null || (await Promise.race([once(sidecar, "exit").then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5_000))]));
  if (!exited) { try { sidecar.kill("SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 1_000));
  removeHome(home);
}
console.log(JSON.stringify(results));
finish();

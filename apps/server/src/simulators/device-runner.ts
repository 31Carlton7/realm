import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:net";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerClient, type RunnerSocket } from "./runner-client";

/**
 * Realm's test runner on a device: built once, started on first use, reused, stopped on the way out.
 *
 * The runner (`resources/ios-device-runner`) is an XCUITest that never finishes. To reach a phone it
 * has to be BUILT with the user's own Apple Development identity, INSTALLED, and RUN by xcodebuild —
 * `test-without-building`, which is what keeps it alive: the test serves until that xcodebuild is
 * stopped, and iOS takes the runner down with it. So a running runner is exactly one child process
 * here, and stopping it is killing that process.
 *
 * Building takes a minute and is done once per runner source, Xcode and team: the products are kept
 * under `<REALM_HOME>/ios-device-runner/build/<key>` and a later start reuses them. The source is
 * copied out of the app first, because xcodebuild writes into the project it builds and a packaged
 * Realm's resources are signed and read-only.
 *
 * Everything that can go wrong is said in words (`RunnerFailure`) with what xcodebuild actually printed
 * as the detail — a signing error is the thing a user can fix, and "xcodebuild exited 65" is not a
 * sentence anyone can act on.
 */

export type RunnerFailure =
  | "no_source" | "no_xcode" | "xcode_too_old" | "no_team" | "sign_failed" | "build_failed"
  | "locked" | "developer_mode" | "ui_automation" | "untrusted" | "not_connected" | "runner_failed";

export class RunnerError extends Error {
  constructor(readonly code: RunnerFailure, message: string, readonly detail: string = "") { super(message); }
}

/** Where the runner goes. `simulator` is the dress rehearsal: the same runner on a simulator, reached
 *  over this Mac's loopback instead of usbmuxd. */
export type RunnerTarget = { udid: string; name: string; osVersion: string; simulator: boolean };

/**
 * The repo-shipped runner source, in the order the skills directory is found (`bundledSkillsDir`):
 * an override, then the workspace root walked up to from this module — the same for `src/` under
 * vitest and the single bundled `dist/main.js` — then a packaged build's resources.
 */
export function deviceRunnerSourceDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.REALM_DEVICE_RUNNER_SOURCE?.trim();
  if (override) return existsSync(override) ? override : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const here = join(dir, "resources", "ios-device-runner");
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(here)) return here;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? join(resources, "ios-device-runner") : null;
  return packaged && existsSync(packaged) ? packaged : null;
}

/** Every file the build reads, relative, in a stable order — what the products are keyed on. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // xcodebuild's own droppings are not source, and would change the key on every build.
      if (name.name === "xcuserdata" || name.name === "project.xcworkspace" || name.name.startsWith(".")) continue;
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path); else out.push(relative(root, path));
    }
  };
  walk(root);
  return out;
}

export function sourceHash(root: string): string {
  const h = createHash("sha256");
  for (const rel of sourceFiles(root)) { h.update(rel); h.update("\0"); h.update(readFileSync(join(root, rel))); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}

/* ── which Xcode ─────────────────────────────────────────────────────────────────────────────── */

type Exec = (bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

const execRun: Exec = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: opts?.timeoutMs ?? 30_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: opts?.env ?? process.env }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (err ? String(err.message) : "") });
    });
  });

export type Xcode = { developerDir: string; version: string };

/** `/Applications/Xcode.app/Contents/Developer` → its version, from the app's own Info.plist. */
async function xcodeVersion(developerDir: string, exec: Exec): Promise<string | null> {
  const plist = join(dirname(developerDir), "Info.plist");
  if (!existsSync(plist)) return null;
  const r = await exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
  return r.code === 0 && /^\d+(\.\d+)*$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

const major = (version: string): number => Number(version.split(".")[0]) || 0;

/**
 * The Xcode to build and run the runner with, for a device on `osVersion`.
 *
 * Xcode and iOS share their major version now, and an Xcode older than the phone cannot test on it —
 * MEASURED here: this Mac's selected Xcode is 26.6 and the phone is on iOS 27.2. So the selected one
 * is used when it is new enough, and otherwise the newest installed Xcode that is; a user who put a
 * beta beside their release Xcode for exactly this has already done the work. `REALM_DEVELOPER_DIR`
 * overrides the choice outright.
 */
export async function chooseXcode(osVersion: string, o: { env?: NodeJS.ProcessEnv; exec?: Exec; applications?: string } = {}): Promise<Xcode> {
  const env = o.env ?? process.env;
  const exec = o.exec ?? execRun;
  const forced = env.REALM_DEVELOPER_DIR?.trim();
  if (forced) {
    const version = await xcodeVersion(forced, exec);
    if (!version) throw new RunnerError("no_xcode", `REALM_DEVELOPER_DIR points at ${forced}, which is not an Xcode.`, `REALM_DEVELOPER_DIR=${forced}`);
    return { developerDir: forced, version };
  }
  const selected = await exec("/usr/bin/xcode-select", ["-p"]);
  const candidates: string[] = [];
  if (selected.code === 0 && selected.stdout.trim()) candidates.push(selected.stdout.trim());
  const apps = o.applications ?? "/Applications";
  try {
    for (const name of readdirSync(apps)) if (/^Xcode.*\.app$/.test(name)) candidates.push(join(apps, name, "Contents", "Developer"));
  } catch { /* no /Applications to read */ }
  const found: Xcode[] = [];
  for (const dir of [...new Set(candidates)]) {
    const version = await xcodeVersion(dir, exec);
    if (version) found.push({ developerDir: dir, version });
  }
  if (found.length === 0) throw new RunnerError("no_xcode", "Realm could not find Xcode on this Mac. A real iPhone is reached through Xcode's test tools, so install Xcode first.");
  const need = major(osVersion);
  const first = found[0]!;
  if (candidates[0] === first.developerDir && major(first.version) >= need) return first;
  const fit = found.filter((x) => major(x.version) >= need)
    .sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
  if (fit) return fit;
  const newest = found.map((x) => x.version).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0]!;
  throw new RunnerError("xcode_too_old", `The phone is on iOS ${osVersion}, and the newest Xcode on this Mac is ${newest}. Testing on iOS ${need} needs Xcode ${need} or later.`, `iOS ${osVersion} on the phone, Xcode ${newest} on this Mac`);
}

/* ── whose identity ──────────────────────────────────────────────────────────────────────────── */

/**
 * The Apple Development teams this Mac can sign for: every valid "Apple Development" identity in the
 * keychain, by the team in its certificate's OU — the certificate NAME carries the person's id, not
 * the team's, so it is read off the certificate itself. `REALM_DEVICE_TEAM` overrides.
 */
export async function signingTeams(o: { env?: NodeJS.ProcessEnv; exec?: Exec } = {}): Promise<string[]> {
  const env = o.env ?? process.env;
  const forced = env.REALM_DEVICE_TEAM?.trim();
  if (forced) return [forced];
  const exec = o.exec ?? execRun;
  const ids = await exec("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const valid = new Set([...ids.stdout.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(?:Apple Development|iPhone Developer): [^"]*"/gm)].map((m) => m[1]!));
  if (valid.size === 0) return [];
  const certs = await exec("/usr/bin/security", ["find-certificate", "-a", "-p", "-c", "Apple Development"]);
  const teams: string[] = [];
  for (const pem of certs.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    let cert: X509Certificate;
    try { cert = new X509Certificate(pem); } catch { continue; }
    if (!valid.has(cert.fingerprint.replace(/:/g, "").toUpperCase())) continue;
    const team = /(?:^|\n)OU=([A-Z0-9]{10})(?:\n|$)/.exec(cert.subject)?.[1];
    if (team && !teams.includes(team)) teams.push(team);
  }
  return teams.sort();
}

/* ── what went wrong, in words ───────────────────────────────────────────────────────────────── */

/**
 * xcodebuild's output → the reason, as the user can act on it. The patterns are the messages
 * xcodebuild and CoreDevice print for each case; anything else keeps its own last error line.
 */
export function classify(output: string, name: string, phase: "build" | "run"): RunnerError {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  // xcodebuild's own `error:` line says what went wrong; "** TEST BUILD FAILED **" after it only says that it did.
  const last = (re: RegExp) => [...lines].reverse().find((l) => re.test(l));
  const errorLine = last(/\berror:/i) ?? last(/failed|unable|not |cannot|could not/i) ?? lines.at(-1) ?? "";
  const detail = errorLine.slice(0, 600);
  const has = (re: RegExp) => re.test(output);
  if (has(/requires a development team|no account for team|No signing certificate|No certificate for team|doesn't match any valid certificate/i)) {
    return new RunnerError("sign_failed", "Realm could not sign its test runner with an Apple Development identity on this Mac. Open Xcode once and sign in under Settings ▸ Accounts.", detail);
  }
  if (has(/No profiles for|provisioning profile|isn't included in the provisioning profile|device .* (?:is not|isn't) registered/i)) {
    return new RunnerError("sign_failed", `Xcode has no development profile that covers ${name}. Run any app on it from Xcode once, which registers the phone with your team.`, detail);
  }
  if (has(/Developer Mode/i)) {
    return new RunnerError("developer_mode", `Developer Mode is off on ${name}. Turn it on in Settings ▸ Privacy & Security ▸ Developer Mode.`, detail);
  }
  if (has(/UI Automation|automation mode|Enable UI Automation/i)) {
    return new RunnerError("ui_automation", `${name} does not allow UI automation. Turn on Settings ▸ Developer ▸ Enable UI Automation.`, detail);
  }
  if (has(/(?:device|phone) (?:is|was) (?:not, or could not be, )?(?:un)?locked|passcode protected|Unlock .* to continue|is locked/i)) {
    return new RunnerError("locked", `${name} is locked. Unlock it and try again — the runner cannot start behind a passcode.`, detail);
  }
  if (has(/not been explicitly trusted|Untrusted Developer|Verify the Developer App|invalid code signature|profile .* not trusted/i)) {
    return new RunnerError("untrusted", `${name} has not trusted your developer certificate. Trust it in Settings ▸ General ▸ VPN & Device Management.`, detail);
  }
  if (has(/Unable to find a destination|is not available|not connected|Could not connect to the device|unpaired/i)) {
    return new RunnerError("not_connected", `Xcode could not reach ${name}. Check the cable, or that it is on the same network.`, detail);
  }
  return phase === "build"
    ? new RunnerError("build_failed", "Realm could not build its test runner.", detail)
    : new RunnerError("runner_failed", `Realm's test runner did not start on ${name}.`, detail);
}

/* ── the runners ─────────────────────────────────────────────────────────────────────────────── */

export type DeviceRunnerDeps = {
  /** `<REALM_HOME>`: builds and logs go under `ios-device-runner/` in it. */
  home: string;
  source?: () => string | null;
  xcode?: (osVersion: string) => Promise<Xcode>;
  teams?: () => Promise<string[]>;
  /** How a runner is reached once it listens — usbmuxd for a phone, loopback for a simulator. */
  socket: (target: RunnerTarget, port: number) => RunnerSocket;
  spawn?: typeof nodeSpawn;
  /** A free port: the runner's own, on the phone's loopback — or, for a simulator, on this Mac's. */
  port?: () => Promise<number>;
  /** A runner that stopped by itself: the test crashed, the cable came out, the phone was locked. */
  onExit?: (udid: string, error: RunnerError) => void;
  timeouts?: { buildMs?: number; readyMs?: number; pollMs?: number; stopMs?: number };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Running = { target: RunnerTarget; child: ChildProcess; client: RunnerClient; port: number; exited: boolean; stopping: boolean; output: string[] };

const BUNDLE_ID = "co.charmtechnologies.realm.device-runner";
const KEEP_LINES = 400;

export class DeviceRunners {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<RunnerClient>>();
  private readonly spawnFn: typeof nodeSpawn;
  private readonly t: { buildMs: number; readyMs: number; pollMs: number; stopMs: number };

  constructor(private readonly d: DeviceRunnerDeps) {
    this.spawnFn = d.spawn ?? nodeSpawn;
    this.t = { buildMs: 900_000, readyMs: 300_000, pollMs: 500, stopMs: 5_000, ...d.timeouts };
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private sleep(ms: number): Promise<void> { return this.d.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms)); }

  /** The runner for this device: the one already running, the one on its way, or a new one. */
  ensure(target: RunnerTarget): Promise<RunnerClient> {
    const live = this.running.get(target.udid);
    if (live && !live.exited && !live.stopping) return Promise.resolve(live.client);
    const pending = this.starting.get(target.udid);
    if (pending) return pending;
    const started = this.start(target).finally(() => this.starting.delete(target.udid));
    this.starting.set(target.udid, started);
    return started;
  }

  /** The runner's client if one is up, without starting anything. */
  client(udid: string): RunnerClient | null {
    const live = this.running.get(udid);
    return live && !live.exited && !live.stopping ? live.client : null;
  }

  async stop(udid: string): Promise<void> {
    const r = this.running.get(udid);
    if (!r) return;
    this.running.delete(udid);
    await this.kill(r);
  }

  async stopAll(): Promise<void> {
    const all = [...this.running.values()];
    this.running.clear();
    await Promise.all(all.map((r) => this.kill(r)));
  }

  /** SIGINT first — xcodebuild then ends the test on the device, which takes the runner app down —
   *  and SIGKILL if it has not gone after a grace period. */
  private async kill(r: Running): Promise<void> {
    r.stopping = true;
    if (r.exited) return;
    const gone = new Promise<void>((resolve) => r.child.once("exit", () => resolve()));
    try { r.child.kill("SIGINT"); } catch { /* already gone */ }
    const timer = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), this.t.stopMs));
    if ((await Promise.race([gone, timer])) === "late") { try { r.child.kill("SIGKILL"); } catch { /* already gone */ } }
  }

  private dir(...parts: string[]): string { return join(this.d.home, "ios-device-runner", ...parts); }

  private log(udid: string, text: string): void {
    try {
      mkdirSync(this.dir("logs"), { recursive: true });
      appendFileSync(this.dir("logs", `${udid}.log`), text);
    } catch { /* a log that cannot be written is not a reason to fail the runner */ }
  }

  private async start(target: RunnerTarget): Promise<RunnerClient> {
    const source = (this.d.source ?? deviceRunnerSourceDir)();
    if (!source) throw new RunnerError("no_source", "This Realm does not carry its device runner, so it cannot drive a real iPhone.");
    const xcode = await (this.d.xcode ?? ((v: string) => chooseXcode(v)))(target.osVersion);
    let team: string | null = null;
    if (!target.simulator) {
      const teams = await (this.d.teams ?? (() => signingTeams()))();
      if (teams.length === 0) throw new RunnerError("no_team", "There is no Apple Development identity on this Mac to sign Realm's test runner with. Open Xcode ▸ Settings ▸ Accounts, sign in, and add a development certificate.");
      team = teams[0]!;
    }
    const xctestrun = await this.build(target, source, xcode, team);
    return this.run(target, xcode, xctestrun);
  }

  /** The runner's products for this source, Xcode and team, built now if they are not there yet. */
  private async build(target: RunnerTarget, source: string, xcode: Xcode, team: string | null): Promise<string> {
    const hash = sourceHash(source);
    const sdk = target.simulator ? "iphonesimulator" : "iphoneos";
    const key = `${sdk}-${team ?? "unsigned"}-${xcode.version}-${hash}`;
    const derived = this.dir("build", key);
    const found = findXctestrun(join(derived, "Build", "Products"));
    if (found) return found;

    // A fresh copy of the source per key: xcodebuild writes into the project it builds.
    const src = this.dir("src", hash);
    if (!existsSync(join(src, "RealmDeviceRunner.xcodeproj"))) {
      rmSync(src, { recursive: true, force: true });
      mkdirSync(src, { recursive: true });
      cpSync(source, src, { recursive: true });
    }
    const base = [
      "build-for-testing",
      "-project", join(src, "RealmDeviceRunner.xcodeproj"),
      "-scheme", "RealmDeviceRunner",
      "-destination", target.simulator ? "generic/platform=iOS Simulator" : "generic/platform=iOS",
      "-derivedDataPath", derived,
      ...(team ? [`DEVELOPMENT_TEAM=${team}`, "CODE_SIGN_STYLE=Automatic", `PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_ID}`] : []),
    ];
    let r = await this.xcodebuild(target, xcode, base, this.t.buildMs);
    /* Asked for a profile only when this Mac has none that covers the runner. A local profile that
       already covers it — a team's wildcard one — builds without Xcode registering anything with the
       user's developer account, which is the change to their account this avoids making by default. */
    if (r.code !== 0 && team && /No profiles for|allowProvisioningUpdates/i.test(r.output)) {
      r = await this.xcodebuild(target, xcode, [...base, "-allowProvisioningUpdates"], this.t.buildMs);
    }
    const built = r.code === 0 ? findXctestrun(join(derived, "Build", "Products")) : null;
    if (!built) throw classify(r.output, target.name, "build");
    return built;
  }

  /** One xcodebuild to completion, its output kept (and logged) for the failure it may explain. */
  private xcodebuild(target: RunnerTarget, xcode: Xcode, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
    this.log(target.udid, `\n=== ${new Date().toISOString()} xcodebuild ${args.join(" ")}\n`);
    return new Promise((resolve) => {
      const child = this.spawnFn("xcodebuild", args, { env: { ...process.env, DEVELOPER_DIR: xcode.developerDir }, stdio: ["ignore", "pipe", "pipe"] });
      const out: string[] = [];
      const take = (b: Buffer) => { const s = b.toString("utf8"); this.log(target.udid, s); out.push(s); if (out.length > KEEP_LINES) out.splice(0, out.length - KEEP_LINES); };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
      child.once("error", (e) => { clearTimeout(timer); resolve({ code: 1, output: `${out.join("")}\n${e.message}` }); });
      child.once("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: out.join("") }); });
    });
  }

  /** `test-without-building`, held open, and waited on until the runner answers. */
  private async run(target: RunnerTarget, xcode: Xcode, xctestrun: string): Promise<RunnerClient> {
    const port = await (this.d.port ?? freePort)();
    const args = ["test-without-building", "-xctestrun", xctestrun, "-destination", `id=${target.udid}`];
    this.log(target.udid, `\n=== ${new Date().toISOString()} xcodebuild ${args.join(" ")} (runner port ${port})\n`);
    const child = this.spawnFn("xcodebuild", args, {
      // xcodebuild hands the test every TEST_RUNNER_-prefixed variable, with the prefix taken off.
      env: { ...process.env, DEVELOPER_DIR: xcode.developerDir, TEST_RUNNER_REALM_RUNNER_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const client = new RunnerClient(this.d.socket(target, port));
    const r: Running = { target, child, client, port, exited: false, stopping: false, output: [] };
    const take = (b: Buffer) => { const s = b.toString("utf8"); this.log(target.udid, s); r.output.push(s); if (r.output.length > KEEP_LINES) r.output.splice(0, r.output.length - KEEP_LINES); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let spawnError: Error | null = null;
    child.once("error", (e) => { spawnError = e; r.exited = true; });
    child.once("exit", () => {
      r.exited = true;
      // A runner that was up and stopped without being asked to: say so, once, to whoever is showing it.
      if (!r.stopping && this.running.get(target.udid) === r) {
        this.running.delete(target.udid);
        this.d.onExit?.(target.udid, classify(r.output.join(""), target.name, "run"));
      }
    });

    const deadline = this.now() + this.t.readyMs;
    for (;;) {
      if (r.exited) {
        throw spawnError ? new RunnerError("no_xcode", "Realm could not run xcodebuild.", (spawnError as Error).message) : classify(r.output.join(""), target.name, "run");
      }
      if (await client.alive()) {
        this.running.set(target.udid, r);
        return client;
      }
      if (this.now() > deadline) {
        r.stopping = true;
        await this.kill(r);
        throw new RunnerError("runner_failed", `Realm's test runner did not answer on ${target.name} within ${Math.round(this.t.readyMs / 1000)} seconds.`, r.output.join("").trim().split("\n").slice(-2).join(" ").slice(0, 600));
      }
      await this.sleep(this.t.pollMs);
    }
  }
}

/** The `.xctestrun` xcodebuild wrote beside the products, or null. */
export function findXctestrun(products: string): string | null {
  try {
    const name = readdirSync(products).find((n) => n.endsWith(".xctestrun"));
    return name ? join(products, name) : null;
  } catch { return null; }
}

/** A port nothing on this Mac is listening on. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

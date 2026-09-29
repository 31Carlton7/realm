import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { chooseXcode, classify, DeviceRunners, deviceRunnerSourceDir, RunnerError, signingTeams, sourceHash, type RunnerTarget } from "./device-runner";
import { loopbackSocket } from "./runner-client";

/**
 * The runner's lifecycle with xcodebuild scripted and the runner played by a loopback server: what
 * is built, with which identity and Xcode, when it is built again, how it is started, reused and
 * stopped, and every way it fails, in words. Nothing here runs xcodebuild or reaches a device.
 */

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) s.closeAllConnections();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

const PHONE: RunnerTarget = { udid: "00008150-0000AAAA1B2C3D4E", name: "Test’s iPhone", osVersion: "27.2", simulator: false };
const SIM: RunnerTarget = { udid: "A7174200-0000-0000-0000-000000000000", name: "iPhone 17e", osVersion: "27.0", simulator: true };
const XCODE = { developerDir: "/Applications/Xcode-27.app/Contents/Developer", version: "27.0" };

/** A runner that answers `/status` once `upAfter` polls have come in — the install and launch. */
async function fakeRunner(o: { upAfter?: number; ours?: boolean } = {}): Promise<{ port: number; polls: () => number }> {
  let polls = 0;
  const server = createServer((req, res) => {
    polls++;
    const up = polls > (o.upAfter ?? 0);
    const body = Buffer.from(up ? JSON.stringify(o.ours === false ? { ok: true } : { ok: true, runner: "realm-device-runner", version: 1 }) : "{}");
    res.writeHead(up ? 200 : 503, { "Content-Length": body.length, Connection: "close" }).end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, polls: () => polls };
}

type Call = { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild };
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  alive = true;
  /** Whether SIGINT is enough, as it is for an xcodebuild that is only waiting on its test. */
  constructor(private readonly obeysSigint = true) { super(); }
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.obeysSigint) this.exit(signal === "SIGKILL" ? 137 : 130);
    return true;
  }
  exit(code: number): void {
    if (!this.alive) return;
    this.alive = false;
    queueMicrotask(() => this.emit("exit", code));
  }
}

/**
 * xcodebuild, scripted. A build writes the .xctestrun where the real one does and exits with `build`'s
 * code, printing its `said`; a test run stays up until killed unless `run` says it dies first.
 */
function xcodebuild(o: {
  build?: { code: number; said?: string }[];
  run?: { dies?: { code: number; said: string }; obeysSigint?: boolean };
} = {}) {
  const calls: Call[] = [];
  const builds = [...(o.build ?? [])];
  const spawnFn = ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = new FakeChild(o.run?.obeysSigint ?? true);
    calls.push({ args, env: opts.env, child });
    if (args[0] === "build-for-testing") {
      const step = builds.shift() ?? { code: 0 };
      setTimeout(() => {
        if (step.code === 0) {
          const products = join(args[args.indexOf("-derivedDataPath") + 1]!, "Build", "Products");
          mkdirSync(products, { recursive: true });
          writeFileSync(join(products, "RealmDeviceRunner_iphoneos27.0-arm64.xctestrun"), "<plist/>");
        }
        if (step.said) child.stdout.write(step.said);
        child.exit(step.code);
      }, 1);
    } else if (o.run?.dies) {
      const dies = o.run.dies;
      setTimeout(() => { child.stderr.write(dies.said); child.exit(dies.code); }, 5);
    }
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}

function source(): string {
  const dir = tempDir("realm-runner-src-");
  mkdirSync(join(dir, "RealmDeviceRunner.xcodeproj"), { recursive: true });
  writeFileSync(join(dir, "RealmDeviceRunner.xcodeproj", "project.pbxproj"), "// project\n");
  mkdirSync(join(dir, "RealmDeviceRunner"), { recursive: true });
  writeFileSync(join(dir, "RealmDeviceRunner", "Runner.swift"), "// runner\n");
  return dir;
}

async function runners(o: { xb?: ReturnType<typeof xcodebuild>; port: number; teams?: string[]; src?: string | null; exits?: [string, RunnerError][]; readyMs?: number }) {
  const home = tempDir("realm-runner-home-");
  const xb = o.xb ?? xcodebuild();
  const exits = o.exits ?? [];
  const r = new DeviceRunners({
    home,
    source: () => (o.src === undefined ? source() : o.src),
    xcode: async () => XCODE,
    teams: async () => o.teams ?? ["ABCDE12345"],
    socket: () => loopbackSocket(o.port),
    spawn: xb.spawnFn,
    port: async () => 7399,
    onExit: (udid, e) => exits.push([udid, e]),
    timeouts: { pollMs: 5, readyMs: o.readyMs ?? 2_000, stopMs: 50 },
  });
  return { r, home, xb, exits };
}

const kinds = (calls: Call[]) => calls.map((c) => c.args[0]);

describe("starting a runner", () => {
  it("builds it signed with the team, runs it on the device, and waits until it answers", async () => {
    const runner = await fakeRunner({ upAfter: 3 });
    const { r, home, xb } = await runners({ port: runner.port });
    const client = await r.ensure(PHONE);
    expect(await client.alive()).toBe(true);
    expect(kinds(xb.calls)).toEqual(["build-for-testing", "test-without-building"]);
    const build = xb.calls[0]!;
    expect(build.args).toEqual(expect.arrayContaining([
      "-scheme", "RealmDeviceRunner", "-destination", "generic/platform=iOS",
      "DEVELOPMENT_TEAM=ABCDE12345", "CODE_SIGN_STYLE=Automatic", "PRODUCT_BUNDLE_IDENTIFIER=co.charmtechnologies.realm.device-runner",
    ]));
    // Built from a copy under Realm's home, never in place: xcodebuild writes into the project it builds.
    expect(build.args[build.args.indexOf("-project") + 1]!.startsWith(join(home, "ios-device-runner", "src"))).toBe(true);
    expect(build.args[build.args.indexOf("-derivedDataPath") + 1]!.startsWith(join(home, "ios-device-runner", "build", "iphoneos-ABCDE12345-27.0-"))).toBe(true);
    expect(build.args).not.toContain("-allowProvisioningUpdates");
    expect(build.env.DEVELOPER_DIR).toBe(XCODE.developerDir);
    const run = xb.calls[1]!;
    expect(run.args).toEqual(["test-without-building", "-xctestrun", expect.stringMatching(/RealmDeviceRunner_iphoneos27\.0-arm64\.xctestrun$/), "-destination", `id=${PHONE.udid}`]);
    expect(run.env).toMatchObject({ DEVELOPER_DIR: XCODE.developerDir, TEST_RUNNER_REALM_RUNNER_PORT: "7399" });
    expect(runner.polls()).toBeGreaterThan(3);
    // Everything xcodebuild said is kept where a person can read it afterwards.
    expect(readFileSync(join(home, "ios-device-runner", "logs", `${PHONE.udid}.log`), "utf8")).toContain("test-without-building");
  });

  it("builds a simulator's for the simulator and signs nothing", async () => {
    const runner = await fakeRunner();
    const { r, xb } = await runners({ port: runner.port, teams: [] });
    await r.ensure(SIM);
    const build = xb.calls[0]!.args;
    expect(build).toEqual(expect.arrayContaining(["-destination", "generic/platform=iOS Simulator"]));
    expect(build.some((a) => a.startsWith("DEVELOPMENT_TEAM="))).toBe(false);
    expect(xb.calls[1]!.args).toContain(`id=${SIM.udid}`);
  });

  it("reuses the one that is running, and a second ask while it starts waits for the same start", async () => {
    const runner = await fakeRunner({ upAfter: 2 });
    const { r, xb } = await runners({ port: runner.port });
    const [a, b] = await Promise.all([r.ensure(PHONE), r.ensure(PHONE)]);
    expect(a).toBe(b);
    expect(await r.ensure(PHONE)).toBe(a);
    expect(kinds(xb.calls)).toEqual(["build-for-testing", "test-without-building"]);
    expect(r.client(PHONE.udid)).toBe(a);
  });

  it("builds once per source: stopped and started again, it only runs", async () => {
    const runner = await fakeRunner();
    const { r, xb } = await runners({ port: runner.port });
    await r.ensure(PHONE);
    await r.stop(PHONE.udid);
    expect(r.client(PHONE.udid)).toBeNull();
    await r.ensure(PHONE);
    expect(kinds(xb.calls)).toEqual(["build-for-testing", "test-without-building", "test-without-building"]);
  });

  it("asks Xcode for a profile only when none on this Mac covers the runner", async () => {
    const runner = await fakeRunner();
    const xb = xcodebuild({ build: [{ code: 65, said: "error: No profiles for 'co.charmtechnologies.realm.device-runner' were found: Xcode couldn't find any iOS App Development provisioning profiles. Automatic signing is disabled and unable to generate a profile. To enable automatic signing, pass -allowProvisioningUpdates to xcodebuild.\n" }, { code: 0 }] });
    const { r } = await runners({ port: runner.port, xb });
    await r.ensure(PHONE);
    expect(xb.calls.filter((c) => c.args[0] === "build-for-testing").map((c) => c.args.includes("-allowProvisioningUpdates"))).toEqual([false, true]);
  });
});

describe("saying why it did not start", () => {
  it("names a signing failure, with xcodebuild's own line", async () => {
    const xb = xcodebuild({ build: [{ code: 65, said: "note: Using codesigning identity override\nerror: Signing for \"RealmDeviceRunner\" requires a development team. Select a development team in the Signing & Capabilities editor.\n** TEST BUILD FAILED **\n" }] });
    const { r } = await runners({ port: 1, xb });
    const e = await r.ensure(PHONE).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RunnerError);
    expect(e).toMatchObject({ code: "sign_failed", detail: expect.stringContaining("requires a development team") });
  });

  it("says a locked phone is locked, and does not wait out the timeout for a runner that died", async () => {
    const xb = xcodebuild({ run: { dies: { code: 70, said: "xcodebuild: error: Unable to launch com.x because the device was not, or could not be, unlocked.\n" } } });
    const { r } = await runners({ port: 1, xb, readyMs: 60_000 });
    const t0 = Date.now();
    await expect(r.ensure(PHONE)).rejects.toMatchObject({ code: "locked", message: expect.stringContaining("is locked") });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("says no identity to sign with before building anything", async () => {
    const xb = xcodebuild();
    const { r } = await runners({ port: 1, xb, teams: [] });
    await expect(r.ensure(PHONE)).rejects.toMatchObject({ code: "no_team" });
    expect(xb.calls).toEqual([]);
  });

  it("says this Realm carries no runner when the source is missing", async () => {
    const { r } = await runners({ port: 1, src: null });
    await expect(r.ensure(PHONE)).rejects.toMatchObject({ code: "no_source" });
  });

  it("gives up on a runner that never answers, and takes the xcodebuild down with it", async () => {
    const runner = await fakeRunner({ ours: false });
    const { r, xb } = await runners({ port: runner.port, readyMs: 100 });
    await expect(r.ensure(PHONE)).rejects.toMatchObject({ code: "runner_failed", message: expect.stringContaining("did not answer") });
    expect(xb.calls[1]!.child.signals).toEqual(["SIGINT"]);
    expect(r.client(PHONE.udid)).toBeNull();
  });

  it.each([
    ["Developer Mode is disabled on the device.", "developer_mode"],
    ["Failed to enable UI Automation for the device.", "ui_automation"],
    ["The application could not be launched because the Developer App Certificate is not trusted. Verify the Developer App certificate for your account is trusted on your device.", "untrusted"],
    ["xcodebuild: error: Unable to find a destination matching the provided destination specifier", "not_connected"],
    ["error: Provisioning profile \"iOS Team Provisioning Profile: *\" doesn't include the currently selected device", "sign_failed"],
    ["Testing failed: something new", "runner_failed"],
  ])("reads %j as %s", (said, code) => {
    expect(classify(said, "Test’s iPhone", "run").code).toBe(code);
  });

  it("calls an unknown build failure a build failure, with its last error line", () => {
    expect(classify("CompileSwift normal\nRoutes.swift:12: error: cannot find 'x' in scope\n** TEST BUILD FAILED **\n", "p", "build"))
      .toMatchObject({ code: "build_failed", detail: "Routes.swift:12: error: cannot find 'x' in scope" });
  });
});

describe("stopping", () => {
  it("interrupts xcodebuild, which ends the test on the device, and kills it if it will not go", async () => {
    const runner = await fakeRunner();
    const xb = xcodebuild({ run: { obeysSigint: false } });
    const { r, exits } = await runners({ port: runner.port, xb });
    await r.ensure(PHONE);
    await r.stop(PHONE.udid);
    expect(xb.calls[1]!.child.signals).toEqual(["SIGINT", "SIGKILL"]);
    // Asked to stop is not stopping by itself: nobody is told the runner went away.
    expect(exits).toEqual([]);
  });

  it("stops every runner on the way out", async () => {
    const runner = await fakeRunner();
    const { r, xb } = await runners({ port: runner.port });
    await r.ensure(PHONE);
    await r.ensure(SIM);
    await r.stopAll();
    expect(xb.calls.filter((c) => c.args[0] === "test-without-building").map((c) => c.child.signals)).toEqual([["SIGINT"], ["SIGINT"]]);
  });

  it("says so when a runner that was up stops by itself — the cable came out, the phone locked", async () => {
    const runner = await fakeRunner();
    const { r, xb, exits } = await runners({ port: runner.port });
    await r.ensure(PHONE);
    const child = xb.calls[1]!.child;
    child.stderr.write("Lost connection to the device.\n");
    await new Promise((res) => setTimeout(res, 5));
    child.exit(65);
    await new Promise((res) => setTimeout(res, 5));
    expect(exits).toHaveLength(1);
    expect(exits[0]![0]).toBe(PHONE.udid);
    expect(exits[0]![1]).toBeInstanceOf(RunnerError);
    expect(r.client(PHONE.udid)).toBeNull();
  });
});

describe("what the build is keyed on", () => {
  it("changes when a source file does, and not for xcodebuild's own droppings", () => {
    const dir = source();
    const before = sourceHash(dir);
    mkdirSync(join(dir, "RealmDeviceRunner.xcodeproj", "project.xcworkspace", "xcuserdata"), { recursive: true });
    writeFileSync(join(dir, "RealmDeviceRunner.xcodeproj", "project.xcworkspace", "xcuserdata", "state"), "x");
    expect(sourceHash(dir)).toBe(before);
    writeFileSync(join(dir, "RealmDeviceRunner", "Runner.swift"), "// changed\n");
    expect(sourceHash(dir)).not.toBe(before);
  });

  it("finds the repo's runner source, and honours an override", () => {
    expect(deviceRunnerSourceDir({})).toMatch(/resources\/ios-device-runner$/);
    const dir = source();
    expect(deviceRunnerSourceDir({ REALM_DEVICE_RUNNER_SOURCE: dir })).toBe(dir);
    expect(deviceRunnerSourceDir({ REALM_DEVICE_RUNNER_SOURCE: join(dir, "nope") })).toBeNull();
  });
});

describe("which Xcode", () => {
  /** An /Applications with these Xcodes in it, and xcode-select pointing at `selected`. */
  function mac(versions: Record<string, string>, selected: string) {
    const apps = tempDir("realm-apps-");
    for (const [name, version] of Object.entries(versions)) {
      mkdirSync(join(apps, name, "Contents", "Developer"), { recursive: true });
      writeFileSync(join(apps, name, "Contents", "Info.plist"), version);
    }
    const exec = async (bin: string, args: string[]) => {
      if (bin.endsWith("xcode-select")) return { code: 0, stdout: `${join(apps, selected, "Contents", "Developer")}\n`, stderr: "" };
      if (bin.endsWith("plutil")) return { code: 0, stdout: readFileSync(args.at(-1)!, "utf8"), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    return { apps, exec, dev: (name: string) => join(apps, name, "Contents", "Developer") };
  }

  it("uses the selected Xcode when it is new enough for the phone", async () => {
    const m = mac({ "Xcode.app": "27.1", "Xcode-beta.app": "27.2" }, "Xcode.app");
    expect(await chooseXcode("27.2", { env: {}, exec: m.exec, applications: m.apps })).toEqual({ developerDir: m.dev("Xcode.app"), version: "27.1" });
  });

  it("reaches for the newest installed Xcode that is, when the selected one is older than the phone", async () => {
    const m = mac({ "Xcode.app": "26.6", "Xcode-27.0.0-Beta.6.app": "27.0", "Xcode-25.app": "25.4" }, "Xcode.app");
    expect(await chooseXcode("27.2", { env: {}, exec: m.exec, applications: m.apps })).toEqual({ developerDir: m.dev("Xcode-27.0.0-Beta.6.app"), version: "27.0" });
  });

  it("says which Xcode the phone needs when none is new enough", async () => {
    const m = mac({ "Xcode.app": "26.6" }, "Xcode.app");
    await expect(chooseXcode("27.2", { env: {}, exec: m.exec, applications: m.apps })).rejects.toMatchObject({
      code: "xcode_too_old", message: "The phone is on iOS 27.2, and the newest Xcode on this Mac is 26.6. Testing on iOS 27 needs Xcode 27 or later.",
      detail: "iOS 27.2 on the phone, Xcode 26.6 on this Mac",
    });
  });

  it("takes REALM_DEVELOPER_DIR at its word", async () => {
    const m = mac({ "Xcode.app": "26.6", "Other.app": "27.0" }, "Xcode.app");
    expect(await chooseXcode("27.2", { env: { REALM_DEVELOPER_DIR: m.dev("Xcode.app") }, exec: m.exec, applications: m.apps })).toEqual({ developerDir: m.dev("Xcode.app"), version: "26.6" });
  });
});

describe("whose identity", () => {
  const CERT = readFileSync(join(__dirname, "fixtures", "test-development-cert.pem"), "utf8");
  const FINGERPRINT = "E7D53095004ABDC529E75DFC692E804B5FBA4691";
  const exec = (identities: string) => async (_bin: string, args: string[]) =>
    ({ code: 0, stdout: args[0] === "find-identity" ? identities : CERT, stderr: "" });

  it("reads the team off the certificate of each valid Apple Development identity", async () => {
    const ids = `  1) ${FINGERPRINT} "Apple Development: Test Person (TESTUSER01)"\n     1 valid identities found\n`;
    expect(await signingTeams({ env: {}, exec: exec(ids) })).toEqual(["ABCDE12345"]);
  });

  it("ignores a certificate with no valid identity behind it, and other kinds of identity", async () => {
    const ids = `  1) ${"0".repeat(40)} "Apple Development: Someone Else (X)"\n  2) ${FINGERPRINT} "Apple Distribution: Test Person (ABCDE12345)"\n`;
    expect(await signingTeams({ env: {}, exec: exec(ids) })).toEqual([]);
  });

  it("takes REALM_DEVICE_TEAM at its word", async () => {
    expect(await signingTeams({ env: { REALM_DEVICE_TEAM: "ZZZZZ99999" }, exec: exec("") })).toEqual(["ZZZZZ99999"]);
  });
});

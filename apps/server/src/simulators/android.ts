import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SimulatorApp, SimulatorAxElement, SimulatorAxTree, SimulatorDevice } from "@realm/contracts";

/**
 * What the Android SDK can tell us, and nothing more.
 *
 * `simctl.ts`'s sibling, written to the same split for the same reason: the shape of the CLI's
 * output is the part that can be wrong, so the parsing is pure and the running is a thin shell
 * around it. A test that needed an emulator installed is a test that runs nowhere.
 *
 * Where this DIVERGES from simctl is worth stating once, because it shapes everything below.
 * `simctl` is one binary that answers about every device on the Mac. Android has three:
 * `emulator` lists and boots virtual devices, `adb` talks to running ones, and the two do not share
 * a name for the same phone — an AVD is `Pixel_7` to the emulator and `emulator-5554` to adb, and
 * the only thing joining them is `adb -s <serial> emu avd name`. So a device here has BOTH, and the
 * serial is null until something is actually running.
 */

/* ── where the SDK is ─────────────────────────────────────────────────────────────────────────── */

/**
 * The SDK root, in the order the Android tools themselves look.
 *
 * `ANDROID_HOME` is the documented one and `ANDROID_SDK_ROOT` the deprecated one that is still set
 * on plenty of machines; the default install path is last because a machine with both an env var
 * and a default path meant the env var. Returns null rather than guessing, so the caller can say
 * "no Android SDK here" instead of failing later with a path nobody recognises.
 */
export function sdkRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const named = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim();
  if (named && existsSync(named)) return named;
  const fallback = join(home, "Library", "Android", "sdk");
  return existsSync(fallback) ? fallback : null;
}

/** Where each tool lives under the SDK root. Overridable for a machine that keeps them elsewhere. */
export function androidBins(env: NodeJS.ProcessEnv = process.env, home: string = homedir()):
  { adb: string | null; emulator: string | null; root: string | null } {
  const root = sdkRoot(env, home);
  const at = (...p: string[]) => (root ? join(root, ...p) : null);
  const adb = env.REALM_ADB_BIN?.trim() || at("platform-tools", "adb");
  const emulator = env.REALM_EMULATOR_BIN?.trim() || at("emulator", "emulator");
  return {
    adb: adb && existsSync(adb) ? adb : null,
    emulator: emulator && existsSync(emulator) ? emulator : null,
    root,
  };
}

/* ── parsing ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * `emulator -list-avds` — one name per line.
 *
 * The binary also prints warnings to stdout on some versions ("INFO | storing crashdata…"), which is
 * why this drops anything with a space in it: an AVD name cannot contain one (the tool rejects it at
 * creation), so a line with a space is never a device.
 */
export function parseAvds(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.includes(" "));
}

export type AdbDevice = { serial: string; state: string; model: string | null };

/**
 * `adb devices -l`.
 *
 * The first line is a banner and is dropped by shape rather than by text — `List of devices
 * attached` is localised on some builds, but it never contains the two-space column gap the rows do.
 * `offline` and `unauthorized` rows are KEPT: they are real devices in a state worth showing, and
 * dropping them is how a picker ends up empty while a phone sits plugged in.
 */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("*") || /^List of devices/i.test(t)) continue;
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(t);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const model = /\bmodel:(\S+)/.exec(rest ?? "")?.[1] ?? null;
    out.push({ serial: serial!, state: state!, model: model ? model.replace(/_/g, " ") : null });
  }
  return out;
}

/**
 * `adb shell wm size` → the framebuffer's size in pixels.
 *
 * Two forms exist and the second wins when present: a device with a size override prints both
 * `Physical size: 1080x2400` and `Override size: 720x1600`, and the override is what is actually on
 * screen — reading the physical one there puts every tap at the wrong place.
 */
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const pick = (label: string) => new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`, "i").exec(stdout);
  const m = pick("Override") ?? pick("Physical");
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** `adb shell pm list packages -3` → `package:com.example.app` per line. Third-party only, because
 *  a list led by 300 system packages is a list nobody scrolls. */
export function parsePackages(stdout: string): SimulatorApp[] {
  const out: SimulatorApp[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^package:(\S+)$/.exec(line.trim());
    if (!m) continue;
    const bundleId = m[1]!;
    // No display name is available without an extra `dumpsys` per package, which on a device with
    // forty apps is forty round trips. The last segment is what a developer calls it anyway.
    out.push({ bundleId, name: bundleId.split(".").pop() || bundleId });
  }
  return out.sort((a, b) => a.bundleId.localeCompare(b.bundleId, "en"));
}

/** `[0,0][1080,2400]` → a frame. Android reports bounds as two corners; everything else in Realm
 *  uses x/y/width/height, and mixing the two draws every overlay in the wrong place. */
export function parseBounds(s: string): { x: number; y: number; width: number; height: number } | null {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(s.trim());
  if (!m) return null;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * `uiautomator dump` XML → the same flat tree the iOS pane already draws.
 *
 * Deliberately a regex scan and not an XML parse. The dump is a single line of well-formed but
 * enormous XML with no namespaces and no text nodes — every fact is an attribute on a `<node>` — so
 * a scan reads it exactly and adds no dependency. Depth comes from counting open tags, which is what
 * lets a self-closing `<node .../>` sit at the same depth as its siblings.
 *
 * Frames are in PIXELS here, where the iOS tree is in POINTS. The contract does not say which, so
 * the platform that produced the tree has to be carried alongside it — see `SimulatorAxTree`'s use
 * in the service. Getting this wrong scales every overlay by the device's pixel ratio.
 */
export function parseUiAutomator(xml: string): SimulatorAxTree {
  const elements: SimulatorAxElement[] = [];
  const counters: number[] = [];
  let depth = 0;
  let screen = { width: 0, height: 0 };
  let app = "";
  const tag = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] ?? "";
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    if (m[0] === "</node>") { depth = Math.max(0, depth - 1); counters.length = depth + 1; continue; }
    const body = m[1] ?? "", selfClosing = m[2] === "/";
    while (counters.length <= depth) counters.push(-1);
    counters[depth] = (counters[depth] ?? -1) + 1;
    const path = counters.slice(0, depth + 1).join(".");
    const frame = parseBounds(attr(body, "bounds")) ?? { x: 0, y: 0, width: 0, height: 0 };
    if (depth === 0) {
      screen = { width: frame.width, height: frame.height };
      app = attr(body, "package");
    }
    const label = attr(body, "text") || attr(body, "content-desc");
    elements.push({
      path,
      label,
      value: attr(body, "text"),
      // `class` is Android's own word for the role and is passed through whole, the way simctl's
      // `type` is: `android.widget.Button` tells a developer more than a mapped "Button" would.
      role: attr(body, "class"),
      id: attr(body, "resource-id") || null,
      enabled: attr(body, "enabled") !== "false",
      frame,
      depth,
    });
    if (!selfClosing) { depth += 1; }
    else { counters.length = depth + 1; }
  }
  return { screen, units: "pixels", app, elements };
}

/**
 * Whether a string can survive `adb shell input text`, and what to send if it can.
 *
 * THE Android trap, and the one already written down in `keysym.ts` and `agent-tools.ts`: `input
 * text` goes through the shell and then through a key-event synthesiser that only knows ASCII.
 * A space must be sent as `%s` or the argument splits; `%` itself must be escaped or it eats the
 * next character; and anything outside printable ASCII is silently dropped or typed as something
 * else. Returning null is what lets the caller REFUSE rather than type the wrong thing, which is the
 * behaviour `vm_act` already chose for the same reason.
 */
export function encodeInputText(text: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(text)) return null;
  return text
    .replace(/%/g, "%%")
    .replace(/ /g, "%s")
    // The shell sees this line; these are the characters that would otherwise be syntax.
    .replace(/([\\"'`$&|;<>()*?~!#])/g, "\\$1");
}

/** The first character `encodeInputText` would refuse, for a message that can point at it. */
export function firstUntypeable(text: string): string | null {
  for (const ch of text) if (!/^[\x20-\x7e]$/.test(ch)) return ch;
  return null;
}

/* ── running the tools ────────────────────────────────────────────────────────────────────────── */

const run = (bin: string, args: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (err ? String(err.message) : "") });
    });
  });

/** Binary output — a screenshot — which `execFile`'s string encoding would corrupt. */
const runBinary = (bin: string, args: string[], timeout: number): Promise<Buffer | null> =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : (stdout as unknown as Buffer)));
  });

export type Android = {
  /** Every AVD on this Mac, joined to whichever are running. */
  devices(): Promise<SimulatorDevice[]>;
  available(): Promise<boolean>;
  /** Start an AVD. Returns as soon as the process is launched — `waitForBoot` is the slow half. */
  boot(avd: string): Promise<{ ok: boolean; detail: string }>;
  waitForBoot(serial: string, deadline: number): Promise<boolean>;
  /** The serial currently hosting this AVD, or null if it is not running. */
  serialFor(avd: string): Promise<string | null>;
  size(serial: string): Promise<{ width: number; height: number } | null>;
  screencap(serial: string): Promise<Buffer | null>;
  ax(serial: string): Promise<SimulatorAxTree | null>;
  apps(serial: string): Promise<SimulatorApp[]>;
  tap(serial: string, x: number, y: number): Promise<void>;
  swipe(serial: string, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>;
  key(serial: string, keycode: string): Promise<void>;
  text(serial: string, s: string): Promise<{ ok: boolean; detail: string }>;
  install(serial: string, apk: string): Promise<{ ok: boolean; detail: string }>;
  launch(serial: string, pkg: string): Promise<{ ok: boolean; detail: string }>;
  openUrl(serial: string, url: string): Promise<{ ok: boolean; detail: string }>;
  stop(serial: string): Promise<{ ok: boolean; detail: string }>;
};

/**
 * The AVD a running emulator is hosting.
 *
 * MEASURED, and not the documented route: `adb -s <serial> emu avd name` is what the docs point at
 * and it returned an EMPTY string on a fully booted emulator here. `ro.boot.qemu.avd_name` is a
 * kernel boot property, is set before anything else comes up, and answered `Realm_Pixel` correctly.
 * The console route is kept as a fallback for a device where the property is absent.
 */
/** How hard to try for a tree. See `ax` — a window mid-animation refuses to be dumped. */
export const AX_ATTEMPTS = 3;
export const AX_RETRY_MS = 1200;

export const AVD_NAME_PROP = "ro.boot.qemu.avd_name";

export function android(env: NodeJS.ProcessEnv = process.env): Android {
  const bins = () => androidBins(env);
  const adbArgs = (serial: string, rest: string[]) => ["-s", serial, ...rest];
  const adb = async (args: string[], timeout = 15000) => {
    const { adb: bin } = bins();
    if (!bin) return { code: 127, stdout: "", stderr: "no adb on this Mac" };
    return run(bin, args, timeout);
  };
  const shell = (serial: string, cmd: string[], timeout = 15000) => adb(adbArgs(serial, ["shell", ...cmd]), timeout);

  const serialToAvd = async (serial: string): Promise<string | null> => {
    const p = await shell(serial, ["getprop", AVD_NAME_PROP], 8000);
    const name = p.stdout.trim();
    if (name) return name;
    const console_ = await adb(adbArgs(serial, ["emu", "avd", "name"]), 8000);
    return console_.stdout.split("\n")[0]?.trim() || null;
  };

  return {
    async available() {
      const { adb: a, emulator: e } = bins();
      return Boolean(a && e);
    },

    async devices() {
      const { adb: a, emulator: e } = bins();
      if (!a || !e) return [];
      const [avdOut, devOut] = await Promise.all([run(e, ["-list-avds"], 15000), run(a, ["devices", "-l"], 10000)]);
      const running = parseAdbDevices(devOut.stdout);
      /* Join the two namespaces. Only emulators can be matched to an AVD; a physical phone has no
         AVD at all and is listed under its own serial, which is the honest thing — it is a real
         device and Realm can drive it exactly the same way. */
      const byAvd = new Map<string, { serial: string; state: string }>();
      const physical: SimulatorDevice[] = [];
      for (const d of running) {
        if (/^emulator-\d+$/.test(d.serial)) {
          const avd = await serialToAvd(d.serial);
          if (avd) { byAvd.set(avd, { serial: d.serial, state: d.state }); continue; }
        }
        physical.push({ udid: d.serial, platform: "android", name: d.model ?? d.serial, runtime: "Android", state: d.state, serial: d.serial });
      }
      const out: SimulatorDevice[] = [];
      for (const avd of parseAvds(avdOut.stdout)) {
        const live = byAvd.get(avd);
        let runtime = "Android";
        if (live) {
          const rel = await shell(live.serial, ["getprop", "ro.build.version.release"], 8000);
          if (rel.stdout.trim()) runtime = `Android ${rel.stdout.trim()}`;
        }
        // The AVD's NAME is the stable identity, underscores and all — it is what `emulator -avd`
        // takes. The label is only prettier for the picker.
        out.push({ udid: avd, platform: "android", name: avd.replace(/_/g, " "), runtime, state: live ? live.state : "Shutdown", serial: live?.serial ?? null });
      }
      return [...out, ...physical].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    },

    async boot(avd) {
      const { emulator } = bins();
      if (!emulator) return { ok: false, detail: "no Android emulator on this Mac" };
      /* Detached and unwaited on purpose: the emulator runs for as long as the device is up, so
         awaiting it would hang until someone closed the phone. `-no-snapshot` because a snapshot
         restores a device that may be in any state, and the pane's contract is a device that just
         booted. */
      const child = execFile(emulator, ["-avd", avd, "-no-audio", "-no-boot-anim", "-no-snapshot"], () => {});
      child.unref?.();
      return { ok: true, detail: "" };
    },

    async waitForBoot(serial, deadline) {
      for (;;) {
        if (Date.now() > deadline) return false;
        const p = await shell(serial, ["getprop", "sys.boot_completed"], 8000);
        if (p.stdout.trim() === "1") return true;
        await new Promise((r) => setTimeout(r, 1500));
      }
    },

    async serialFor(avd) {
      const { adb: a } = bins();
      if (!a) return null;
      const devs = parseAdbDevices((await run(a, ["devices", "-l"], 10000)).stdout);
      for (const d of devs) {
        if (d.state !== "device") continue;
        if (d.serial === avd) return d.serial;            // a physical device, addressed by serial
        if (await serialToAvd(d.serial) === avd) return d.serial;
      }
      return null;
    },

    async size(serial) { return parseWmSize((await shell(serial, ["wm", "size"], 8000)).stdout); },

    async screencap(serial) {
      const { adb: a } = bins();
      if (!a) return null;
      // `exec-out` and not `shell`: `shell` mangles binary on some transports by translating CRLF,
      // which corrupts every PNG it carries. This is the documented fix and the reason for a
      // separate binary runner.
      return runBinary(a, adbArgs(serial, ["exec-out", "screencap", "-p"]), 20000);
    },

    async ax(serial) {
      /* Dump to a file and cat it back, rather than `uiautomator dump /dev/tty`. The /dev/tty form
         appends the tool's own success line to the XML and is documented as unreliable; the file
         round trip costs one extra call and is exact.

         Retried, because MEASURED: uiautomator refuses to dump while a window is animating — it
         answers "could not get idle state" — and the moment anyone most wants the tree is the
         moment just after a tap, which is exactly when something is animating. One attempt makes
         the tree randomly unavailable; three across three seconds makes it reliable. */
      for (let attempt = 0; attempt < AX_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, AX_RETRY_MS));
        const dump = await shell(serial, ["uiautomator", "dump", "/sdcard/realm-ui.xml"], 30000);
        if (!/dumped to/i.test(dump.stdout)) continue;
        const xml = await shell(serial, ["cat", "/sdcard/realm-ui.xml"], 15000);
        if (!xml.stdout.includes("<hierarchy")) continue;
        return parseUiAutomator(xml.stdout);
      }
      return null;
    },

    async apps(serial) { return parsePackages((await shell(serial, ["pm", "list", "packages", "-3"], 15000)).stdout); },

    async tap(serial, x, y) { await shell(serial, ["input", "tap", String(Math.round(x)), String(Math.round(y))], 8000); },
    async swipe(serial, x1, y1, x2, y2, ms) {
      await shell(serial, ["input", "swipe", ...[x1, y1, x2, y2].map((n) => String(Math.round(n))), String(Math.max(1, Math.round(ms)))], 12000);
    },
    async key(serial, keycode) { await shell(serial, ["input", "keyevent", keycode], 8000); },

    async text(serial, s) {
      const encoded = encodeInputText(s);
      if (encoded === null) {
        const ch = firstUntypeable(s);
        // Refused, not mangled — see `encodeInputText`. The character is named so the message can be
        // acted on rather than just apologised for.
        return { ok: false, detail: `Android's input can only type printable ASCII, and this has ${ch ? `"${ch}"` : "a character"} in it.` };
      }
      if (encoded === "") return { ok: true, detail: "" };
      const r = await shell(serial, ["input", "text", encoded], 15000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : r.stderr || r.stdout };
    },

    async install(serial, apk) {
      const r = await adb(adbArgs(serial, ["install", "-r", apk]), 180000);
      const ok = r.code === 0 && /Success/i.test(r.stdout);
      return { ok, detail: ok ? "" : (r.stderr || r.stdout).trim() };
    },

    async launch(serial, pkg) {
      // `monkey` finds the launcher activity itself; `am start` needs the fully qualified component,
      // which nothing here knows without another dumpsys.
      const r = await shell(serial, ["monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], 20000);
      const ok = r.code === 0 && !/No activities found/i.test(r.stdout + r.stderr);
      return { ok, detail: ok ? "" : (r.stderr || r.stdout).trim() || "that package has nothing to launch" };
    },

    async openUrl(serial, url) {
      const r = await shell(serial, ["am", "start", "-a", "android.intent.action.VIEW", "-d", url], 20000);
      const ok = r.code === 0 && !/Error/i.test(r.stderr);
      return { ok, detail: ok ? "" : (r.stderr || r.stdout).trim() };
    },

    async stop(serial) {
      // `emu kill` is the emulator's own clean shutdown. A physical device has no such thing, and
      // saying so is better than silently doing nothing.
      if (!/^emulator-\d+$/.test(serial)) return { ok: false, detail: "a physical device cannot be shut down from here" };
      const r = await adb(adbArgs(serial, ["emu", "kill"]), 10000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : (r.stderr || r.stdout).trim() };
    },
  };
}

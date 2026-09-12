import { execFile } from "node:child_process";
import type { SimulatorApp, SimulatorDevice } from "@realm/contracts";

/**
 * What `xcrun simctl` can tell us, and nothing more.
 *
 * The parse is separate from the run for the reason every other CLI wrapper here splits them: the
 * shape of `simctl list`'s JSON is the part that can be wrong, and a test that has to have Xcode
 * installed to check it is a test that does not run anywhere.
 */

/** Repointable for tests and for a Mac whose Xcode lives somewhere unusual. */
export const simctlBin = (env: NodeJS.ProcessEnv = process.env): string =>
  env.REALM_XCRUN_BIN?.trim() || "xcrun";

type Dump = { devices?: Record<string, unknown> };
type RawDevice = { udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown };

/**
 * `com.apple.CoreSimulator.SimRuntime.iOS-27-0` → `iOS 27.0`.
 *
 * The runtime key is the only thing that tells two identically-named devices apart, and the raw
 * identifier is 40 characters of prefix nobody reads. Anything that does not match the shape is
 * passed through whole rather than mangled — a runtime Apple names differently later should read
 * oddly in the picker, not vanish from it.
 */
export function runtimeLabel(key: string): string {
  const tail = key.split(".").pop() ?? key;
  const m = /^([A-Za-z]+)-(\d+)-(\d+)(?:-(\d+))?$/.exec(tail);
  if (!m) return tail;
  return `${m[1]} ${[m[2], m[3], m[4]].filter(Boolean).join(".")}`;
}

/**
 * The devices in a `simctl list devices --json` dump, newest runtime first.
 *
 * Unavailable devices are dropped: a device whose runtime is not installed cannot boot, and the
 * picker offering one would be offering a row whose only outcome is an error. Everything else is
 * passed through — including `state`, which is simctl's word rather than one of ours.
 */
export function parseDevices(stdout: string): SimulatorDevice[] {
  let dump: Dump;
  try { dump = JSON.parse(stdout) as Dump; } catch { return []; }
  const out: SimulatorDevice[] = [];
  for (const [runtime, list] of Object.entries(dump.devices ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const d of list as RawDevice[]) {
      if (typeof d?.udid !== "string" || typeof d.name !== "string") continue;
      if (d.isAvailable === false) continue;
      out.push({ udid: d.udid, platform: "ios", name: d.name, runtime: runtimeLabel(runtime),
        state: typeof d.state === "string" ? d.state : "Unknown", serial: null });
    }
  }
  /* Platform first and alphabetically, then that platform's NEWEST runtime, then by name.
     Sorting the whole label descending — the obvious one line — is wrong in a way that is invisible
     until a Mac has a watch runtime installed: "watchOS" sorts above "iOS" on the first letter, and
     the picker's top row becomes an Apple Watch on a Mac whose developer has never built one. */
  const platform = (runtime: string) => runtime.split(" ")[0] ?? runtime;
  const version = (runtime: string) => runtime.slice(platform(runtime).length).trim();
  return out.sort((a, b) =>
    platform(a.runtime).localeCompare(platform(b.runtime), "en")
    || version(b.runtime).localeCompare(version(a.runtime), "en", { numeric: true })
    || a.name.localeCompare(b.name, "en", { numeric: true }));
}

const run = (bin: string, args: string[], timeout: number, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ENOENT and a non-zero exit are the same kind of answer here — "this did not work, and here
      // is what it said" — and every caller wants the text either way.
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (err ? String(err.message) : "") });
    });
    // `simctl pbcopy` takes what it is to paste on STDIN, and there is no argument form of it.
    if (stdin !== undefined) { child.stdin?.end(stdin); }
  });

/**
 * The apps in a `simctl listapps` dump.
 *
 * The output is an old-style plist and there is no `--json` for it, so this reads the few keys that
 * matter rather than parsing the format. It does NOT count braces: each entry opens with
 * `"com.example.app" =     {` at a known indent, and the text up to the NEXT such header is that
 * entry — which is what makes nested blocks (`GroupContainers`, `SBAppTags`) harmless. A non-greedy
 * match to the first `};` reads correctly on this runtime only because the display name happens to
 * precede the first nested block, and that is not a thing to depend on.
 *
 * Hidden apps are dropped — they have no icon on the home screen and cannot be launched — and the
 * user's OWN apps sort first, because on a developer's simulator that is the one they came for.
 */
export function parseApps(stdout: string): SimulatorApp[] {
  const header = /^\s{2,}"?([A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+)"?\s*=\s*\{\s*$/gm;
  const starts: { id: string; at: number }[] = [];
  for (const m of stdout.matchAll(header)) starts.push({ id: m[1]!, at: m.index! + m[0]!.length });
  const out: SimulatorApp[] = [];
  const seen = new Set<string>();
  starts.forEach((entry, i) => {
    if (seen.has(entry.id)) return;
    const body = stdout.slice(entry.at, i + 1 < starts.length ? starts[i + 1]!.at : undefined);
    const key = (k: string): string | null => {
      const m = new RegExp(`^\\s*${k}\\s*=\\s*(?:"([^"]*)"|([^;\\n]+));`, "m").exec(body);
      return (m?.[1] ?? m?.[2])?.trim() ?? null;
    };
    if (key("IsHidden") === "1") return;
    seen.add(entry.id);
    out.push({ bundleId: entry.id, name: key("CFBundleDisplayName") || key("CFBundleName") || entry.id });
  });
  const mine = (id: string) => !id.startsWith("com.apple.");
  return out.sort((a, b) =>
    Number(mine(b.bundleId)) - Number(mine(a.bundleId))
    || a.name.localeCompare(b.name, "en", { numeric: true }));
}

export type Simctl = {
  devices(): Promise<SimulatorDevice[]>;
  boot(udid: string): Promise<{ ok: boolean; detail: string }>;
  available(): Promise<boolean>;
  /** Everything installed on the device, the user's own apps among Apple's. */
  apps(udid: string): Promise<SimulatorApp[]>;
  /** A PNG of the device's screen, written where Realm asked for it. `simctl` is the authority here
   *  rather than the stream: it captures the framebuffer directly, at full resolution, with no JPEG
   *  between the device and the file. */
  screenshot(udid: string, path: string): Promise<{ ok: boolean; detail: string }>;
  /** Open a URL on the device — a deep link into an app, or a page in Safari. */
  openUrl(udid: string, url: string): Promise<{ ok: boolean; detail: string }>;
  /** Install a built `.app` bundle or an `.ipa`. */
  install(udid: string, path: string): Promise<{ ok: boolean; detail: string }>;
  launch(udid: string, bundleId: string): Promise<{ ok: boolean; detail: string }>;
  /** Put pictures and videos into the device's own Photos library. */
  addMedia(udid: string, paths: string[]): Promise<{ ok: boolean; detail: string }>;
  /** The device's pasteboard, both ways. */
  pasteTo(udid: string, text: string): Promise<{ ok: boolean; detail: string }>;
  copyFrom(udid: string): Promise<{ ok: boolean; text: string; detail: string }>;
};

export function simctl(env: NodeJS.ProcessEnv = process.env): Simctl {
  const bin = simctlBin(env);
  return {
    async devices() {
      const r = await run(bin, ["simctl", "list", "devices", "available", "--json"], 20_000);
      return r.code === 0 ? parseDevices(r.stdout) : [];
    },
    async boot(udid) {
      const r = await run(bin, ["simctl", "boot", udid], 120_000);
      // "Unable to boot device in current state: Booted" is the happy path arriving late — two panes
      // pointed at one device, or a simulator the user already had open in Xcode.
      const text = `${r.stdout}${r.stderr}`.trim();
      if (r.code === 0 || /current state: Booted/i.test(text)) return { ok: true, detail: text };
      return { ok: false, detail: text || `xcrun exited ${r.code}` };
    },
    async available() {
      const r = await run(bin, ["simctl", "help"], 10_000);
      return r.code === 0;
    },
    async apps(udid) {
      const r = await run(bin, ["simctl", "listapps", udid], 30_000);
      return r.code === 0 ? parseApps(r.stdout) : [];
    },
    async screenshot(udid, path) {
      const r = await run(bin, ["simctl", "io", udid, "screenshot", path], 30_000);
      return said(r);
    },
    async openUrl(udid, url) {
      const r = await run(bin, ["simctl", "openurl", udid, url], 30_000);
      return said(r);
    },
    async install(udid, path) {
      const r = await run(bin, ["simctl", "install", udid, path], 300_000);
      return said(r);
    },
    async launch(udid, bundleId) {
      const r = await run(bin, ["simctl", "launch", udid, bundleId], 60_000);
      return said(r);
    },
    async addMedia(udid, paths) {
      const r = await run(bin, ["simctl", "addmedia", udid, ...paths], 120_000);
      return said(r);
    },
    async pasteTo(udid, text) {
      // `pbcopy` reads the text from stdin, which `execFile` has no way to write — so the text goes
      // through `simctl pbcopy`'s own argument-free form via a shell pipe would need a shell. This
      // writes it with `io <udid> pasteboard` instead, which takes the text as an argument.
      const r = await run(bin, ["simctl", "pbcopy", udid], 15_000, text);
      return said(r);
    },
    async copyFrom(udid) {
      const r = await run(bin, ["simctl", "pbpaste", udid], 15_000);
      return { ...said(r), text: r.code === 0 ? r.stdout : "" };
    },
  };
}

/** What every one-shot command answers with: whether it worked, and what it said if it did not. */
const said = (r: { code: number; stdout: string; stderr: string }): { ok: boolean; detail: string } =>
  ({ ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `xcrun exited ${r.code}` });

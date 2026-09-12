import { execFile } from "node:child_process";
import type { SimulatorAxElement, SimulatorAxTree, SimulatorCameraSource, SimulatorEvent, SimulatorScreen, SimulatorUiState } from "@realm/contracts";

/**
 * The `serve-sim` daemon: what Realm asks it for, and what it answers with.
 *
 * Realm never parses the human-readable banner — the CLI prints JSON for exactly this, and the
 * banner is the thing that changes between releases. Everything below reads `--list`/`--detach`
 * output, or an HTTP route on the daemon itself.
 *
 * The daemon outlives the command that starts it (`--detach`), which is why nothing here holds a
 * child process handle. That is also the honest shape of the thing: a stream belongs to the DEVICE,
 * two panes on one simulator share it, and closing a pane must not take the other one's pixels away.
 */

/** How Realm runs the CLI. An installed `serve-sim` is preferred over `npx`, which needs the network
 *  the first time and takes seconds every time; the env var is the escape hatch and the test seam. */
export function serveSimCommand(env: NodeJS.ProcessEnv = process.env): { bin: string; prefix: string[] } {
  const override = env.REALM_SERVE_SIM_BIN?.trim();
  if (override) return { bin: override, prefix: [] };
  return { bin: "npx", prefix: ["--yes", "serve-sim@latest"] };
}

/** One running stream, as `--list` describes it. The URLs are loopback and already inside the
 *  renderer's `img-src`/`connect-src`, which is why they can be handed to the pane verbatim. */
export type ServeSimStream = { running: boolean; device: string | null; url: string | null; streamUrl: string | null; wsUrl: string | null; port: number | null; pid: number | null };

const NOTHING: ServeSimStream = { running: false, device: null, url: null, streamUrl: null, wsUrl: null, port: null, pid: null };

/**
 * The JSON line in whatever the CLI printed.
 *
 * `--list` with nothing running prints `{"running":false}`, and `--detach` prints the stream it just
 * started with no `running` field at all — so a payload carrying a `streamUrl` IS a running stream,
 * and that is what this asserts rather than the flag.
 */
export function parseStream(stdout: string): ServeSimStream {
  for (const line of stdout.split("\n").map((l) => l.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    let v: Record<string, unknown>;
    try { v = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const str = (k: string): string | null => (typeof v[k] === "string" && v[k] !== "" ? (v[k] as string) : null);
    const streamUrl = str("streamUrl");
    if (!streamUrl) return { ...NOTHING, running: v.running === true };
    return {
      running: true, device: str("device"), url: str("url"), streamUrl, wsUrl: str("wsUrl"),
      port: typeof v.port === "number" ? v.port : null,
      pid: typeof v.pid === "number" ? v.pid : null,
    };
  }
  return NOTHING;
}

/**
 * `serve-sim ui status --json` → what each option is set to.
 *
 * Every value is taken as a STRING whatever it is: the device is the authority on its own settings,
 * and an option Realm has never heard of arriving from a newer serve-sim must reach the menu rather
 * than be dropped on the way. Anything that is not a flat object of strings is no answer at all.
 */
export function parseUiState(stdout: string): SimulatorUiState | null {
  for (const line of stdout.split("\n").map((l) => l.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      const out: SimulatorUiState = {};
      for (const [k, value] of Object.entries(v)) if (typeof value === "string") out[k] = value;
      return Object.keys(out).length > 0 ? out : null;
    } catch { continue; }
  }
  return null;
}

/**
 * `/helper/<udid>/ax` → the tree, flattened.
 *
 * What arrives is an ARRAY of root nodes, each `{ AXLabel, AXValue, AXUniqueId, enabled, frame,
 * type, role_description?, children }`, and the frames are in POINTS — the root Application node on
 * a 1320×2868 iPhone reports 440×956. That shape was read off the running daemon rather than out of
 * the skill's write-up, which describes an older `{screen, elements}` body that this build does not
 * send; a parser written from the documentation would find nothing at all.
 *
 * Flattened because a tree is what the device has and a LIST is what a pane can draw and a person
 * can scan. The index path is kept as the handle, so an element can still be spoken about after the
 * list has been sorted or filtered.
 */
export function parseAxTree(body: string): SimulatorAxTree | null {
  let roots: unknown;
  try { roots = JSON.parse(body); } catch { return null; }
  const list = Array.isArray(roots) ? roots : [roots];
  const root = list[0] as Record<string, unknown> | undefined;
  if (!root || typeof root !== "object") return null;
  const rootFrame = frameOf(root);
  if (!rootFrame) return null;
  const elements: SimulatorAxElement[] = [];
  const walk = (node: Record<string, unknown>, path: string, depth: number): void => {
    const frame = frameOf(node);
    // The Application node is the SCREEN, not an element on it: an overlay that drew it would put a
    // box around everything and call it a control.
    if (frame && depth > 0) {
      elements.push({
        path,
        label: str(node.AXLabel),
        value: str(node.AXValue),
        role: str(node.type) || str(node.role_description) || "Element",
        id: typeof node.AXUniqueId === "string" && node.AXUniqueId ? node.AXUniqueId : null,
        enabled: node.enabled !== false,
        frame,
        depth,
      });
    }
    const kids = Array.isArray(node.children) ? (node.children as Record<string, unknown>[]) : [];
    kids.forEach((k, i) => walk(k, path === "" ? String(i) : `${path}.${i}`, depth + 1));
  };
  list.forEach((n, i) => walk(n as Record<string, unknown>, String(i), 0));
  // Points: the tree itself reports them, and a 1320x2868 iPhone says 440x956 here.
  return { screen: { width: rootFrame.width, height: rootFrame.height }, units: "points", app: str(root.AXLabel), elements };
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const frameOf = (node: Record<string, unknown>): { x: number; y: number; width: number; height: number } | null => {
  const f = node.frame as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") return null;
  const n = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : null);
  const [x, y, width, height] = [n("x"), n("y"), n("width"), n("height")];
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
};

/** `event-log --json` → the lines worth showing. The payload carries a `details` object per event
 *  that is the whole frame that was sent; the summary is what a person reads. */
export function parseEvents(stdout: string): SimulatorEvent[] {
  for (const line of stdout.split("\n").map((l) => l.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line) as { events?: unknown };
      if (!Array.isArray(v.events)) continue;
      return (v.events as Record<string, unknown>[]).map((e) => ({
        source: str(e.source), kind: str(e.kind) || str(e.action),
        summary: str(e.summary), at: typeof e.at === "string" ? e.at : typeof e.time === "string" ? e.time : null,
      }));
    } catch { continue; }
  }
  // The CLI pretty-prints its JSON, so the last LINE is rarely the whole payload — fall back to
  // parsing the lot, which is what a multi-line body needs.
  try {
    const v = JSON.parse(stdout) as { events?: unknown };
    if (Array.isArray(v.events)) {
      return (v.events as Record<string, unknown>[]).map((e) => ({
        source: str(e.source), kind: str(e.kind) || str(e.action),
        summary: str(e.summary), at: typeof e.at === "string" ? e.at : null,
      }));
    }
  } catch { /* not JSON at all */ }
  return [];
}

/** serve-sim reports `{"width":0,"height":0}` until the capture engine has a frame — a number nobody
 *  can scale a pane to. Treated as "not yet", not as a screen. */
export function parseScreen(body: string): SimulatorScreen | null {
  try {
    const v = JSON.parse(body) as { width?: unknown; height?: unknown; orientation?: unknown };
    if (typeof v.width !== "number" || typeof v.height !== "number" || v.width <= 0 || v.height <= 0) return null;
    return { width: Math.round(v.width), height: Math.round(v.height), orientation: typeof v.orientation === "string" ? v.orientation : "portrait" };
  } catch { return null; }
}

const run = (bin: string, args: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (err ? String(err.message) : "") });
    });
  });

export type ServeSim = {
  /** The stream for one device, or `NOTHING`. Adopting one that is already up is the whole reason
   *  this is asked before anything is started — a simulator someone served from a terminal, or from
   *  the ios-simulator skill, is a simulator this pane can just show. */
  find(udid: string): Promise<ServeSimStream>;
  start(udid: string): Promise<{ stream: ServeSimStream; detail: string }>;
  kill(udid: string): Promise<void>;
  /** The device's framebuffer size, once there is one. */
  screen(stream: ServeSimStream, udid: string): Promise<SimulatorScreen | null>;
  /** Every simulator-wide UI option and its current value, or null when the CLI could not answer. */
  ui(udid: string): Promise<SimulatorUiState | null>;
  /**
   * Set one option. Answers with what the device reports AFTERWARDS rather than with the value that
   * was asked for: `serve-sim ui <option> <value>` prints nothing on success, and an option that
   * silently refused would otherwise leave the menu showing a state the phone is not in.
   */
  setUi(udid: string, option: string, value: string): Promise<{ ok: boolean; state: SimulatorUiState | null; detail: string }>;
  /** One `didReceiveMemoryWarning` to the foreground app. */
  memoryWarning(udid: string): Promise<{ ok: boolean; detail: string }>;
  /** A CoreAnimation debug overlay on or off. */
  caDebug(udid: string, option: string, on: boolean): Promise<{ ok: boolean; detail: string }>;
  /** The foreground app's accessibility tree — what is actually on screen, by name rather than by
   *  pixel. Null when the daemon has no answer yet (the AX framework warms up after a boot). */
  ax(stream: ServeSimStream, udid: string): Promise<SimulatorAxTree | null>;
  /** Grant, revoke or reset one permission for one app. */
  permission(udid: string, action: string, permission: string, bundleId: string): Promise<{ ok: boolean; detail: string }>;
  /** Launch an app with a synthetic camera feed injected into it. */
  camera(udid: string, bundleId: string, source: SimulatorCameraSource): Promise<{ ok: boolean; detail: string }>;
  /** Hot-swap the feed of a camera helper that is already attached. */
  cameraSwitch(udid: string, source: SimulatorCameraSource): Promise<{ ok: boolean; detail: string }>;
  cameraStop(udid: string): Promise<{ ok: boolean; detail: string }>;
  /** This Mac's own cameras, for the `webcam` source. */
  webcams(): Promise<string[]>;
  eventLog(udid: string, limit: number): Promise<SimulatorEvent[]>;
};

/** The CLI flags one camera source is. Kept beside the type it switches on so a new source cannot be
 *  added to the contract without the command that serves it. */
const cameraArgs = (source: SimulatorCameraSource): string[] => {
  if (source.kind === "file") return ["--file", source.path];
  if (source.kind === "webcam") return source.name ? ["--webcam", source.name] : ["--webcam"];
  return [];
};

export function serveSim(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ServeSim {
  const { bin, prefix } = serveSimCommand(env);
  return {
    async find(udid) {
      const r = await run(bin, [...prefix, "--list", udid], 60_000);
      return r.code === 0 ? parseStream(r.stdout) : NOTHING;
    },
    async start(udid) {
      // `-q` is JSON-only: the banner is what a human reads and what a parser trips over.
      const r = await run(bin, [...prefix, "--detach", "-q", udid], 180_000);
      const stream = parseStream(r.stdout);
      return { stream, detail: stream.streamUrl ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async kill(udid) {
      await run(bin, [...prefix, "--kill", udid], 60_000);
    },
    async screen(stream, udid) {
      if (!stream.url) return null;
      try {
        const res = await fetchImpl(`${stream.url}/helper/${encodeURIComponent(udid)}/config`, { signal: AbortSignal.timeout(4_000) });
        return res.ok ? parseScreen(await res.text()) : null;
      } catch { return null; }
    },
    async ui(udid) {
      const r = await run(bin, [...prefix, "ui", "status", "--json", "-d", udid], 60_000);
      return r.code === 0 ? parseUiState(r.stdout) : null;
    },
    async setUi(udid, option, value) {
      const r = await run(bin, [...prefix, "ui", option, value, "-d", udid], 60_000);
      // The CLI prints its own accepted set on a bad value; that sentence is better than any
      // paraphrase, so it travels to the pane whole.
      const detail = r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim().split("\n")[0] ?? `serve-sim exited ${r.code}`;
      return { ok: r.code === 0, state: await this.ui(udid), detail };
    },
    async memoryWarning(udid) {
      const r = await run(bin, [...prefix, "memory-warning", "-d", udid], 60_000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async caDebug(udid, option, on) {
      const r = await run(bin, [...prefix, "ca-debug", option, on ? "on" : "off", "-d", udid], 60_000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async ax(stream, udid) {
      if (!stream.url) return null;
      try {
        // Scoped to the device, like `/config`: the unscoped `/ax` answers with an SSE keepalive and
        // no tree, which reads as "no elements" rather than as "wrong route".
        const res = await fetchImpl(`${stream.url}/helper/${encodeURIComponent(udid)}/ax`, { signal: AbortSignal.timeout(8_000) });
        return res.ok ? parseAxTree(await res.text()) : null;
      } catch { return null; }
    },
    async permission(udid, action, permission, bundleId) {
      const r = await run(bin, [...prefix, "permissions", action, permission, bundleId, "-d", udid], 60_000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async camera(udid, bundleId, source) {
      // Minutes, not seconds: the first run builds the injector dylib, and a timeout here would
      // leave the build running with nobody waiting for it.
      const r = await run(bin, [...prefix, "camera", bundleId, ...cameraArgs(source), "-d", udid], 300_000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async cameraSwitch(udid, source) {
      const arg = source.kind === "file" ? source.path : source.kind === "webcam" ? (source.name ?? "webcam") : "placeholder";
      const r = await run(bin, [...prefix, "camera", "switch", arg, "-d", udid], 60_000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async cameraStop(udid) {
      const r = await run(bin, [...prefix, "camera", "--stop-webcam", "-d", udid], 60_000);
      return { ok: r.code === 0, detail: r.code === 0 ? "" : `${r.stdout}${r.stderr}`.trim() || `serve-sim exited ${r.code}` };
    },
    async webcams() {
      const r = await run(bin, [...prefix, "camera", "--list-webcams"], 60_000);
      if (r.code !== 0) return [];
      // One name per line, minus the CLI's own furniture: a bullet, a heading, npx's noise.
      return r.stdout.split("\n").map((l) => l.replace(/^[\s•*-]+/, "").trim())
        .filter((l) => l && !/^(usage|host camera|npm|serve-sim)/i.test(l));
    },
    async eventLog(udid, limit) {
      const r = await run(bin, [...prefix, "event-log", "--json", "-n", String(limit), "-d", udid], 60_000);
      return r.code === 0 ? parseEvents(r.stdout) : [];
    },
  };
}

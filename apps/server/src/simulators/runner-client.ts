import { connect as tcpConnect } from "node:net";
import type { Duplex } from "node:stream";
import type { SimulatorAxTree } from "@realm/contracts";
import { parseRunnerTree, type RunnerElement } from "./runner-tree";

/**
 * Realm's side of the device runner's HTTP API (`resources/ios-device-runner/.../Routes.swift`).
 *
 * The runner answers one request per connection and closes it, so this is a page of HTTP rather than
 * a client library: write the request, read to the end, split the head from the body. The socket is
 * a SEAM, because how it is reached is the one thing that differs between devices — on a phone it is
 * a usbmuxd connection to the phone's own loopback (`usbmux.ts`), on a simulator it is this Mac's
 * loopback — and a suite hands in a socket it wrote itself.
 */

/** Opens one connection to the runner, however the device is reached. */
export type RunnerSocket = () => Promise<Duplex>;

export type RunnerResponse = { status: number; body: Buffer };

/** The runner did not answer at all — no socket, no response, or not in time. Different in kind from
 *  an answer that says no, which is `{ ok: false }` below. */
export class RunnerUnreachable extends Error {}

/** A plain TCP connection to a port on this Mac: a runner on a simulator, which shares its loopback. */
export const loopbackSocket = (port: number): RunnerSocket => () =>
  new Promise((resolve, reject) => {
    const s = tcpConnect({ port, host: "127.0.0.1" });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });

export async function runnerRequest(open: RunnerSocket, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<RunnerResponse> {
  let socket: Duplex;
  try { socket = await open(); } catch (e) { throw new RunnerUnreachable(e instanceof Error ? e.message : String(e)); }
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise<RunnerResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => { socket.destroy(); reject(new RunnerUnreachable(`the runner did not answer ${path} within ${(timeoutMs / 1000).toFixed(timeoutMs < 1_000 ? 1 : 0)} s`)); }), timeoutMs);
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.once("error", (e: Error) => finish(() => reject(new RunnerUnreachable(e.message))));
    // The runner closes the connection once its answer is written; a reset instead of a close is the
    // same ending as far as what arrived goes.
    const done = () => finish(() => {
      const parsed = parseResponse(Buffer.concat(chunks));
      socket.destroy();
      if (parsed) resolve(parsed);
      else reject(new RunnerUnreachable(`the runner's answer to ${path} was not HTTP`));
    });
    socket.once("end", done);
    socket.once("close", done);
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`);
    if (payload.length > 0) socket.write(payload);
  });
}

/** Status line, headers, body — the body cut at Content-Length when there is one. */
export function parseResponse(raw: Buffer): RunnerResponse | null {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const head = raw.subarray(0, end).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "");
  if (!status) return null;
  const length = head.map((l) => /^content-length:\s*(\d+)\s*$/i.exec(l)).find(Boolean);
  const rest = raw.subarray(end + 4);
  return { status: Number(status[1]), body: length ? rest.subarray(0, Number(length[1])) : rest };
}

/** What an act answers: done, or the runner's own sentence for why not. */
export type RunnerAct = { ok: boolean; detail: string };

const said = (r: RunnerResponse): RunnerAct => {
  if (r.status === 200) return { ok: true, detail: "" };
  let detail = r.body.toString("utf8");
  try { detail = String((JSON.parse(detail) as { error?: unknown }).error ?? detail); } catch { /* the body is the sentence */ }
  return { ok: false, detail: detail || `the runner answered ${r.status}` };
};

/** The screen in POINTS, and how many pixels a point is. */
export type RunnerScreen = { width: number; height: number; scale: number };

export class RunnerClient {
  constructor(private readonly open: RunnerSocket) {}

  /** Whether the thing answering is Realm's runner, rather than anything else on that port. */
  async alive(timeoutMs = 3_000): Promise<boolean> {
    try {
      const r = await runnerRequest(this.open, "GET", "/status", undefined, timeoutMs);
      return r.status === 200 && (JSON.parse(r.body.toString("utf8")) as { runner?: unknown }).runner === "realm-device-runner";
    } catch { return false; }
  }

  async screen(): Promise<RunnerScreen> {
    const r = await runnerRequest(this.open, "GET", "/device");
    const v = JSON.parse(r.body.toString("utf8")) as Partial<RunnerScreen>;
    if (r.status !== 200 || !(Number(v.width) > 0) || !(Number(v.height) > 0)) throw new RunnerUnreachable("the runner did not say how big the screen is");
    return { width: Number(v.width), height: Number(v.height), scale: Number(v.scale) > 0 ? Number(v.scale) : 1 };
  }

  /** The bundle id of the app in front — `com.apple.springboard` for the home screen and the lock
   *  screen — and nothing that app shows. */
  async foreground(): Promise<string> {
    const r = await runnerRequest(this.open, "GET", "/foreground");
    const id = (JSON.parse(r.body.toString("utf8")) as { bundleId?: unknown }).bundleId;
    if (r.status !== 200 || typeof id !== "string") throw new RunnerUnreachable("the runner did not say which app is in front");
    return id;
  }

  /** The foreground app's tree, or null when the runner answered with something that is not one. */
  async tree(timeoutMs = 15_000): Promise<(SimulatorAxTree & { bundleId: string; elements: RunnerElement[] }) | null> {
    const r = await runnerRequest(this.open, "GET", "/hierarchy", undefined, timeoutMs);
    return r.status === 200 ? parseRunnerTree(r.body.toString("utf8")) : null;
  }

  async screenshot(o: { format: "png" } | { format: "jpeg"; scale: number; quality: number }): Promise<Buffer> {
    const q = o.format === "png" ? "format=png" : `format=jpeg&scale=${o.scale}&quality=${o.quality}`;
    const r = await runnerRequest(this.open, "GET", `/screenshot?${q}`, undefined, 30_000);
    if (r.status !== 200 || r.body.length === 0) throw new RunnerUnreachable("the runner did not send a picture of the screen");
    return r.body;
  }

  tap(x: number, y: number, count: 1 | 2, holdMs?: number): Promise<RunnerAct> {
    return this.act("/tap", { x, y, count, ...(holdMs !== undefined ? { holdMs } : {}) });
  }

  swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number, holdMs: number, stopMs?: number): Promise<RunnerAct> {
    return this.act("/swipe", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs, holdMs, ...(stopMs ? { stopMs } : {}) });
  }

  text(text: string): Promise<RunnerAct> { return this.act("/text", { text }, 60_000); }
  key(key: "return" | "delete" | "space"): Promise<RunnerAct> { return this.act("/key", { key }); }
  button(button: "home" | "volume-up" | "volume-down"): Promise<RunnerAct> { return this.act("/button", { button }); }
  openUrl(url: string): Promise<RunnerAct> { return this.act("/open", { url }); }

  private async act(path: string, body: unknown, timeoutMs = 30_000): Promise<RunnerAct> {
    try {
      return said(await runnerRequest(this.open, "POST", path, body, timeoutMs));
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

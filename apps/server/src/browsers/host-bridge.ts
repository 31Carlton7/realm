import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { RpcServer } from "../rpc/server";

/** Ops the bridge is willing to relay — one place that names the protocol, shared (by convention, the
 *  two processes compile separately) with Electron main's dispatcher. Anything else is refused here,
 *  so a typo'd op fails loudly at the caller instead of timing out against a confused host. */
export const BROWSER_HOST_OPS = [
  "describe", "snapshot", "read", "act", "navigate", "screenshot",
  /** Enrolled sign-ins, metadata only (`BrowserCredential` has no value field). */
  "credentials",
  /** Type one enrolled sign-in into a ref. The VALUE never crosses this bridge in either direction:
   *  the request carries a `credentialId`, the answer carries `{ ok, detail }`. Everything secret
   *  happens on the far side, inside Electron main. */
  "fillCredential",
  /**
   * Hand realm-server the `oauth` domain key from main's safeStorage-anchored keyring, so
   * `readOauthState` can stay synchronous while tokens stop being plaintext in `realm.db`.
   *
   * There is deliberately no op that exports the `credential` key, and no op that opens a blob on
   * main's behalf. Both would be short additions, and either would undo the reason this list is
   * enumerated in one place.
   */
  "oauthKey",
  /** Arm a one-shot download grant, click the ref, and await the file. The DIRECTORY is decided
   *  server-side (from the space's project) and travels with the op — main never picks a path, and
   *  the page never influences one. */
  "download",
] as const;

/**
 * The computer-use ops, relayed over the SAME socket. There is one main↔server connection and one
 * registered executor, so a second bridge would be a parallel copy of this file's reconnect,
 * timeout and supersede handling for no gain — but the two op families are named separately because
 * they answer to different hosts in main and have nothing else in common.
 */
export const COMPUTER_HOST_OPS = [
  /** Running apps, plus both TCC grants — the grant state rides along so an empty or failing list is
   *  never ambiguous between "nothing is running" and "nothing is permitted". */
  "computerListApps",
  "computerSnapshot",
  "computerAct",
] as const;

export const HOST_OPS = [...BROWSER_HOST_OPS, ...COMPUTER_HOST_OPS] as const;
/** Every op the bridge will relay, of either family. */
export type HostOp = (typeof HOST_OPS)[number];

/** How long one op may run before the bridge gives up on it. Snapshot fuses four CDP calls plus a
 *  listener sweep; a heavy page can take seconds — but a minute means the view is gone or the page is
 *  hung, and the agent deserves an answer either way. */
const OP_TIMEOUT_MS = 60_000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * The server half of the main↔server browser bridge (Plan 11 W3).
 *
 * The `WebContentsView`s and their `webContents.debugger` live in Electron main; the agent tools live
 * here in realm-server (on the MCP gateway). This class is the seam between them: Electron main
 * connects to the RPC socket like any client, calls `browserHost.register`, and from then on every
 * tool's CDP work travels out as a targeted `browserHost.op` event and comes back as a
 * `browserHost.result` call. One host at a time — a second register supersedes the first (an Electron
 * main that restarted), failing whatever the old one still owed.
 *
 * It carries the computer-use ops too (`COMPUTER_HOST_OPS`), which have nothing to do with browser
 * panes but travel the same one main↔server socket to the same one registered executor. The name is
 * the browser's because that is what first needed a bridge; the machinery was never browser-specific.
 */
export class BrowserHostBridge {
  private host: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: { rpc: RpcServer }) {}

  /** Whether an executor is currently connected — the tools' "is the app even running?" check. */
  get connected(): boolean {
    return this.host !== null;
  }

  /** `browserHost.register`: adopt this socket as THE executor. A previous host's unanswered ops are
   *  failed now — their answers would come from a process that no longer owns any views. */
  register(client: WebSocket): void {
    if (this.host && this.host !== client) this.failAll("browser host replaced by a new registration");
    this.host = client;
    client.once("close", () => {
      if (this.host !== client) return; // already superseded; the new host's ops are not ours to fail
      this.host = null;
      this.failAll("browser host disconnected");
    });
  }

  /** `browserHost.result`: settle one op. Unknown callIds are ignored — a late answer to an op that
   *  already timed out, or a stale host still flushing after being superseded. */
  handleResult(p: { callId: string; ok: boolean; result?: unknown; error?: string }): void {
    const entry = this.pending.get(p.callId);
    if (!entry) return;
    this.pending.delete(p.callId);
    clearTimeout(entry.timer);
    if (p.ok) entry.resolve(p.result);
    else entry.reject(new Error(p.error || "browser host reported an unnamed failure"));
  }

  /** Run one op on the registered host. Rejects (never hangs) when no host is connected, when the
   *  socket drops mid-op, and after `OP_TIMEOUT_MS`. */
  call(op: HostOp, params: Record<string, unknown>): Promise<unknown> {
    if (!(HOST_OPS as readonly string[]).includes(op)) return Promise.reject(new Error(`unknown host op "${op}"`));
    const host = this.host;
    if (!host) return Promise.reject(new Error("the Realm app is not connected — browser tools need the desktop app running"));
    const callId = randomBytes(9).toString("base64url");
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(callId)) reject(new Error(`browser host op "${op}" timed out after ${OP_TIMEOUT_MS / 1000}s`));
      }, OP_TIMEOUT_MS);
      this.pending.set(callId, { resolve, reject, timer });
      if (!this.d.rpc.sendTo(host, "browserHost.op", { callId, op, params })) {
        this.pending.delete(callId);
        clearTimeout(timer);
        reject(new Error("the Realm app disconnected — browser tools need the desktop app running"));
      }
    });
  }

  private failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

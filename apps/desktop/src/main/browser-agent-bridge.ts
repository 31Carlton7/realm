/**
 * Electron main's side of the browser agent bridge (Plan 11 W3): a WebSocket client on realm-server's
 * own RPC socket. On connect it calls `browserHost.register` — from then on the server sends this
 * process (and only this process) `browserHost.op` events, each answered with a `browserHost.result`
 * call. The wire is the ordinary RPC wire; nothing new to speak, just a client that happens to live
 * in main instead of the renderer.
 */

export type HandleOp = (op: string, params: Record<string, unknown>) => Promise<unknown>;

/** The protocol core, pure over strings so it is testable without a socket. */
export function createBridgeCore(handleOp: HandleOp, sendRaw: (json: string) => void) {
  let n = 0;
  const request = (method: string, params: unknown): void => {
    sendRaw(JSON.stringify({ id: `bh_${++n}`, method, params }));
  };
  return {
    onOpen(): void {
      request("browserHost.register", {});
    },
    async onMessage(raw: string): Promise<void> {
      let msg: unknown;
      try { msg = JSON.parse(raw); } catch { return; }
      const m = msg as { event?: string; payload?: { callId?: string; op?: string; params?: Record<string, unknown> } };
      if (m.event !== "browserHost.op" || !m.payload?.callId) return; // responses/other events: not ours
      const { callId, op, params } = m.payload;
      try {
        const result = await handleOp(String(op ?? ""), params ?? {});
        request("browserHost.result", { callId, ok: true, result });
      } catch (e) {
        request("browserHost.result", { callId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

const RECONNECT_MS = 2_000;

/** Connect (and keep reconnecting) to realm-server on the given port. Uses Node's built-in global
 *  WebSocket — no dependency, and main already knows the port from the server's ready line. */
export function startBrowserAgentBridge(opts: { port: number; handleOp: HandleOp; onLog?: (line: string) => void }): { stop(): void } {
  let stopped = false;
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const connect = (): void => {
    if (stopped) return;
    const socket = new WebSocket(`ws://127.0.0.1:${opts.port}`);
    ws = socket;
    const core = createBridgeCore(opts.handleOp, (json) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(json);
    });
    socket.addEventListener("open", () => { opts.onLog?.("[browser-agent] bridge connected"); core.onOpen(); });
    socket.addEventListener("message", (ev) => { void core.onMessage(typeof ev.data === "string" ? ev.data : ""); });
    socket.addEventListener("close", () => {
      if (stopped || ws !== socket) return;
      opts.onLog?.("[browser-agent] bridge disconnected; retrying");
      timer = setTimeout(connect, RECONNECT_MS);
    });
    socket.addEventListener("error", () => { /* close fires next; reconnect happens there */ });
  };
  connect();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

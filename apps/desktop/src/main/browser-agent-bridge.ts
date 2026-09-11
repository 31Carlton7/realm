/**
 * Electron main's side of the browser agent bridge (Plan 11 W3): a WebSocket client on realm-server's
 * own RPC socket. On connect it calls `browserHost.register` — from then on the server sends this
 * process (and only this process) `browserHost.op` events, each answered with a `browserHost.result`
 * call. The wire is the ordinary RPC wire; nothing new to speak, just a client that happens to live
 * in main instead of the renderer.
 */

export type HandleOp = (op: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * The protocol core, pure over strings so it is testable without a socket.
 *
 * It began as a one-way relay — register, then answer ops — and is now also a small RPC client,
 * because main needs to ask realm-server questions of its own: how many sessions are working, for the
 * menu-bar item that is the only thing visible after the window closes. That reuses THIS socket
 * rather than opening a second one, since the core already sees every frame and drops the ones that
 * are not ops; making it notice responses and events costs a pending map.
 */
export function createBridgeCore(handleOp: HandleOp, sendRaw: (json: string) => void, onEvent?: (event: string, payload: unknown) => void, hasWindow?: () => boolean) {
  let n = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notify = (method: string, params: unknown): void => {
    sendRaw(JSON.stringify({ id: `bh_${++n}`, method, params }));
  };
  return {
    onOpen(): void {
      // The window state goes with the FIRST register, not just the re-registers: a bridge that
      // reconnected while the app was resident would otherwise tell the server a window is open and
      // make every browser op fail with a message naming the wrong problem.
      notify("browserHost.register", { hasWindow: hasWindow?.() ?? true });
    },
    /** Ask realm-server something. Rejects when the socket drops, exactly as the renderer's client
     *  does — the caller retries on the next connect rather than waiting on a dead socket. */
    call(method: string, params: unknown): Promise<unknown> {
      const id = `bh_${++n}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sendRaw(JSON.stringify({ id, method, params }));
      });
    },
    /** The socket went away: nothing in flight can ever be answered. */
    onClose(): void {
      for (const p of pending.values()) p.reject(new Error("realm-server disconnected"));
      pending.clear();
    },
    async onMessage(raw: string): Promise<void> {
      let msg: unknown;
      try { msg = JSON.parse(raw); } catch { return; }
      const m = msg as {
        id?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string };
        event?: string; payload?: { callId?: string; op?: string; params?: Record<string, unknown> };
      };
      if (typeof m.id === "string" && m.ok !== undefined) {
        const p = pending.get(m.id);
        if (!p) return; // a reply to a notify, or to a call whose socket already dropped
        pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(`${m.error?.code ?? "ERROR"}: ${m.error?.message ?? ""}`));
        return;
      }
      if (m.event !== undefined && m.event !== "browserHost.op") { onEvent?.(m.event, m.payload); return; }
      if (m.event !== "browserHost.op" || !m.payload?.callId) return;
      const { callId, op, params } = m.payload;
      try {
        const result = await handleOp(String(op ?? ""), params ?? {});
        notify("browserHost.result", { callId, ok: true, result });
      } catch (e) {
        notify("browserHost.result", { callId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

export type BridgeClient = { call(method: string, params: unknown): Promise<unknown> };

const RECONNECT_MS = 2_000;

/** Connect (and keep reconnecting) to realm-server on the given port. Uses Node's built-in global
 *  WebSocket — no dependency, and main already knows the port from the server's ready line. `token`
 *  is read from the daemon state file and offered as the `realm.<token>` subprotocol; the server
 *  refuses the handshake without it. */
export function startBrowserAgentBridge(opts: {
  port: number; token: string; handleOp: HandleOp; onLog?: (line: string) => void;
  /** Liveness, for the daemon supervisor. This socket is the only continuous signal main has about a
   *  server it may not own — there is no child to watch exit — and it already redials forever, so
   *  `onDisconnected` fires once per failed attempt and is the supervisor's tick as well as its
   *  signal. */
  onConnected?: (client: BridgeClient) => void;
  onDisconnected?: () => void;
  /** Every non-op event realm-server broadcasts. Main subscribes to `session.status` for the tray's
   *  counts and to `notifications.changed` for the toasts it shows when there is no window. */
  onEvent?: (event: string, payload: unknown) => void;
  /** Whether a window is open right now, read at each (re)connect. */
  hasWindow?: () => boolean;
}): { stop(): void } {
  let stopped = false;
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const connect = (): void => {
    if (stopped) return;
    const socket = new WebSocket(`ws://127.0.0.1:${opts.port}`, [`realm.${opts.token}`]);
    ws = socket;
    const core = createBridgeCore(opts.handleOp, (json) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(json);
    }, opts.onEvent, opts.hasWindow);
    socket.addEventListener("open", () => { opts.onLog?.("[browser-agent] bridge connected"); core.onOpen(); opts.onConnected?.(core); });
    socket.addEventListener("message", (ev) => { void core.onMessage(typeof ev.data === "string" ? ev.data : ""); });
    socket.addEventListener("close", () => {
      if (stopped || ws !== socket) return;
      opts.onLog?.("[browser-agent] bridge disconnected; retrying");
      core.onClose();
      opts.onDisconnected?.();
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

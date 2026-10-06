import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createApnsSender, type ApnsSender } from "./apns";
import { parseRoute, RelayRoom, type Attachment, type RoomHost, type RoomStorage, type Route } from "./core";
import { webCrypto } from "./crypto";

export type { ApnsPush, ApnsResult, ApnsSender } from "./apns";

export type LocalRelayOptions = {
  /** 0 or absent picks a free port. */
  port?: number;
  /** Where pushes go. Absent, every push answers `apns-not-configured`, as an unconfigured Worker does. */
  apns?: ApnsSender;
};

export type LocalRelay = {
  /** The relay base `r` of a pairing link: `ws://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  close(): Promise<void>;
};

/** workerd hands the room frames far past 1 MiB, so the room's own check is what a client meets and
 *  4413 is the answer. `ws` must do the same, so its cap sits well above 1 MiB; it only bounds what
 *  one frame can make this process buffer. */
const RUNTIME_MAX_PAYLOAD = 32 << 20;

/**
 * The relay on a local port, for tests and live checks where a Mac and a phone meet without
 * Cloudflare. It runs core.ts exactly as the Durable Object does; only the plumbing differs:
 * - one room per macId, its storage in memory, so it lasts as long as this process;
 * - the heartbeat is answered here before the room sees it, as workerd's auto-response does;
 * - a timer stands in for the Durable Object alarm.
 */
export async function startLocalRelay(options: LocalRelayOptions = {}): Promise<LocalRelay> {
  const apns = options.apns ?? createApnsSender({});
  const rooms = new Map<string, LocalRoom>();
  const pending = new Set<Promise<void>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: RUNTIME_MAX_PAYLOAD });
  const server = createServer(respond);

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = parseRoute(pathOf(req));
    if (!route) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let room = rooms.get(route.macId);
      if (!room) rooms.set(route.macId, (room = new LocalRoom(apns, pending)));
      room.accept(ws, route);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}`,
    async close() {
      for (const room of rooms.values()) room.stop();
      await Promise.all([...wss.clients].map(goodbye));
      await Promise.all([...pending]);
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function respond(req: IncomingMessage, res: ServerResponse): void {
  const path = pathOf(req);
  if (path === "/health" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "content-type": "text/plain;charset=UTF-8" }).end("ok");
  } else if (parseRoute(path)) {
    res.writeHead(426, { upgrade: "websocket" }).end("this is a WebSocket endpoint");
  } else {
    res.writeHead(404).end("not found");
  }
}

const pathOf = (req: IncomingMessage): string => new URL(req.url ?? "/", "http://relay").pathname;

/** Closes a client politely, then not: a peer that never answers the close must not hold up close(). */
function goodbye(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const force = setTimeout(() => ws.terminate(), 1_000);
    ws.once("close", () => {
      clearTimeout(force);
      resolve();
    });
    ws.close(1001, "relay stopped");
  });
}

type LocalSocket = { ws: WebSocket; attachment: Attachment | null; heartbeatAt: number | null };

class LocalRoom implements RoomHost<LocalSocket> {
  readonly crypto = webCrypto;
  readonly storage: RoomStorage;
  private readonly room: RelayRoom<LocalSocket>;
  private readonly members = new Set<LocalSocket>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    readonly apns: ApnsSender,
    private readonly pending: Set<Promise<void>>,
  ) {
    // Values are copied in and out, as Durable Object storage copies them, so the room cannot
    // depend on sharing an object with its own storage.
    const stored = new Map<string, unknown>();
    this.storage = {
      get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
      put: async (key, value) => void stored.set(key, structuredClone(value)),
      delete: async (key) => void stored.delete(key),
    };
    this.room = new RelayRoom(this);
  }

  accept(ws: WebSocket, route: Route): void {
    const socket: LocalSocket = { ws, attachment: null, heartbeatAt: null };
    this.members.add(socket);
    this.room.open(socket, route).catch(report);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) {
        this.room.message(socket, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).catch(report);
        return;
      }
      const text = bytes.toString("utf8");
      // workerd answers exactly this text itself and never wakes the room for it.
      if (text === "ping") {
        socket.heartbeatAt = Date.now();
        ws.send("pong");
        return;
      }
      this.room.message(socket, text).catch(report);
    });
    ws.on("close", () => {
      // Still a member until the room has handled the close, as a Durable Object's socket is.
      void this.room
        .closed(socket)
        .catch(report)
        .finally(() => this.members.delete(socket));
    });
    // An error is always followed by "close", which does the tidying.
    ws.on("error", () => {});
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  sockets(): LocalSocket[] {
    return [...this.members];
  }

  attachment(socket: LocalSocket): Attachment | null {
    return socket.attachment && structuredClone(socket.attachment);
  }

  setAttachment(socket: LocalSocket, attachment: Attachment): void {
    socket.attachment = structuredClone(attachment);
  }

  send(socket: LocalSocket, data: string | Uint8Array): void {
    if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(data);
  }

  close(socket: LocalSocket, code: number, reason: string): void {
    socket.ws.close(code, reason);
  }

  heartbeatAt(socket: LocalSocket): number | null {
    return socket.heartbeatAt;
  }

  async setAlarm(at: number | null): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (at === null || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.room.alarm().catch(report);
    }, Math.max(0, at - Date.now()));
    this.timer.unref?.();
  }

  now(): number {
    return Date.now();
  }

  background(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
  }
}

function report(error: unknown): void {
  console.error("relay: event failed", error);
}

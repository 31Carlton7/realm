import { DurableObject } from "cloudflare:workers";
import { createApnsSender, type ApnsSender } from "./apns";
import { parseRoute, RelayRoom, type Attachment, type RoomHost } from "./core";
import { webCrypto } from "./crypto";
import type { Env } from "./env";

/**
 * One Mac's room: its socket and its phones' sockets, on the WebSocket Hibernation API so a quiet
 * room costs nothing. Every rule is RelayRoom's; this class only lends it the runtime.
 */
export class MacRoom extends DurableObject<Env> {
  private readonly room: RelayRoom<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // §3: the runtime answers the heartbeat itself, so a Mac and its phones keep their sockets alive
    // without waking this object. getWebSocketAutoResponseTimestamp still records each one.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.room = new RelayRoom(new DurableHost(ctx, apnsFor(env)));
  }

  async fetch(request: Request): Promise<Response> {
    const route = parseRoute(new URL(request.url).pathname);
    if (!route || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a relay WebSocket", { status: 400 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [route.role]);
    await this.room.open(server, route);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.room.message(ws, message).catch(report);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.room.closed(ws).catch(report);
    // Answer the client's close, or its side never finishes closing. The answer echoes its code,
    // except 1005 and 1006, which only report a close that carried no code and cannot be sent.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "");
    } catch {
      // The runtime already answered it.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.room.closed(ws).catch(report);
  }

  async alarm(): Promise<void> {
    // Let a failure throw: the runtime retries an alarm that throws, and this one enforces deadlines.
    await this.room.alarm();
  }
}

class DurableHost implements RoomHost<WebSocket> {
  readonly crypto = webCrypto;
  readonly storage;

  constructor(
    private readonly ctx: DurableObjectState,
    readonly apns: ApnsSender,
  ) {
    const kv = ctx.storage;
    this.storage = {
      get: <T>(key: string) => kv.get<T>(key),
      put: (key: string, value: unknown) => kv.put(key, value),
      delete: async (key: string) => {
        await kv.delete(key);
      },
    };
  }

  sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  attachment(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }

  setAttachment(ws: WebSocket, attachment: Attachment): void {
    ws.serializeAttachment(attachment);
  }

  send(ws: WebSocket, data: string | Uint8Array): void {
    try {
      ws.send(data);
    } catch {
      // Closed under us; its close event will tidy up.
    }
  }

  close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  heartbeatAt(ws: WebSocket): number | null {
    try {
      return this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
    } catch {
      return null;
    }
  }

  async setAlarm(at: number | null): Promise<void> {
    // An alarm, not a timer: it fires even while the object hibernates, which is when the auth
    // deadline and the pairing window's expiry most need enforcing.
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  now(): number {
    return Date.now();
  }

  background(work: Promise<unknown>): void {
    this.ctx.waitUntil(work);
  }
}

// Per isolate rather than per room, so the APNs token cache outlives a room's hibernation and is
// shared by every Mac's room in this isolate.
let shared: { config: string; sender: ApnsSender } | null = null;

function apnsFor(env: Env): ApnsSender {
  const config = { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, keyP8: env.APNS_KEY_P8, topic: env.APNS_TOPIC, origin: env.APNS_ORIGIN };
  const fingerprint = JSON.stringify(config);
  if (shared?.config !== fingerprint) shared = { config: fingerprint, sender: createApnsSender(config) };
  return shared.sender;
}

function report(error: unknown): void {
  console.error("relay: event failed", error);
}

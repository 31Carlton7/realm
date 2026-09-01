import { WebSocketServer, WebSocket } from "ws";
import type { ZodTypeAny, z } from "zod";
import { parseWireMessage, type EventName, type EventPayload, type RpcResponse } from "@realm/contracts";
import { RpcError } from "../store/rows";

type Handler<S extends ZodTypeAny> = (params: z.infer<S>, ctx: { client: WebSocket }) => Promise<unknown>;

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private methods = new Map<string, { schema: ZodTypeAny; handler: Handler<ZodTypeAny> }>();
  private clients = new Set<WebSocket>();

  register<S extends ZodTypeAny>(name: string, schema: S, handler: Handler<S>): void {
    this.methods.set(name, { schema, handler: handler as Handler<ZodTypeAny> });
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host });
      this.wss = wss;
      wss.once("error", reject);
      wss.on("listening", () => {
        // After listen, errors are no longer fatal to the caller; log them instead of crashing on an unhandled 'error'.
        wss.on("error", (err) => process.stderr.write(`[realm-server] ws error: ${err.message}\n`));
        const addr = wss.address(); resolve(typeof addr === "object" && addr ? addr.port : port);
      });
      wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", (err) => process.stderr.write(`[realm-server] client error: ${err.message}\n`));
        ws.on("message", (data) => void this.handle(ws, data.toString()));
      });
    });
  }

  broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
    const msg = JSON.stringify({ event, payload });
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  /** Send one event to ONE client (the `ctx.client` a handler captured) — the browser host bridge's op
   *  channel (Plan 11 W3), where a broadcast would spray CDP work at every connected renderer. Returns
   *  false when the socket is no longer open, so the caller can fail its op instead of waiting on a
   *  message nobody received. */
  sendTo<E extends EventName>(client: WebSocket, event: E, payload: EventPayload<E>): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    client.send(JSON.stringify({ event, payload }));
    return true;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    await new Promise<void>((res) => (this.wss ? this.wss.close(() => res()) : res()));
  }

  private async handle(ws: WebSocket, raw: string): Promise<void> {
    let id = "?";
    const send = (r: RpcResponse): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r)); };
    try {
      const wire = parseWireMessage(raw);
      if (wire.kind !== "request") return;
      id = wire.msg.id;
      const m = this.methods.get(wire.msg.method);
      if (!m) return send({ id, ok: false, error: { code: "METHOD_NOT_FOUND", message: wire.msg.method } });
      const parsed = m.schema.safeParse(wire.msg.params);
      if (!parsed.success) return send({ id, ok: false, error: { code: "INVALID_PARAMS", message: parsed.error.message } });
      const result = await m.handler(parsed.data, { client: ws });
      send({ id, ok: true, result });
    } catch (e) {
      send({ id, ok: false, error: toRpcError(e) });
    }
  }
}

/** Only RpcError codes cross the wire; everything else is INTERNAL. */
function toRpcError(e: unknown): { code: string; message: string } {
  if (e instanceof RpcError) return { code: e.code, message: e.message };
  const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return { code: "INTERNAL", message };
}

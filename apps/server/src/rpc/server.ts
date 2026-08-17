import { WebSocketServer, WebSocket } from "ws";
import type { ZodTypeAny, z } from "zod";
import { parseWireMessage, type RpcResponse } from "@realm/contracts";

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
      wss.on("listening", () => { const addr = wss.address(); resolve(typeof addr === "object" && addr ? addr.port : port); });
      wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("message", (data) => void this.handle(ws, data.toString()));
      });
    });
  }

  broadcast(event: string, payload: unknown): void {
    const msg = JSON.stringify({ event, payload });
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
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
      const err = e as { code?: string; message?: string };
      send({ id, ok: false, error: { code: err.code ?? "INTERNAL", message: err.message ?? String(e) } });
    }
  }
}

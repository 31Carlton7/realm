import { SELF } from "cloudflare:test";
import { TestSocket, type WebSocketLike } from "../shared/socket";

/** Opens a relay socket through the Worker's own fetch handler, as a client's upgrade would arrive. */
export async function connect(path: string): Promise<TestSocket> {
  const res = await SELF.fetch(`https://relay.test${path}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected a WebSocket upgrade, got ${res.status}`);
  // Binary arrives as a Blob by default; the relay's frames are read as bytes.
  ws.binaryType = "arraybuffer";
  const socket = new TestSocket(ws as unknown as WebSocketLike);
  ws.accept();
  return socket;
}

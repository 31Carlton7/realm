import { WebSocket } from "ws";
import { TestSocket, type WebSocketLike } from "../shared/socket";

/** Opens a `ws` client to `url`, with binary frames as ArrayBuffers as workerd delivers them. */
export async function connectWs(url: string): Promise<TestSocket> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  // `ws` throws an "error" event nobody listens for; the close that follows is what tests read.
  ws.on("error", () => {});
  const socket = new TestSocket(ws as unknown as WebSocketLike);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("close", (code) => reject(new Error(`closed before opening (${code})`)));
  });
  return socket;
}

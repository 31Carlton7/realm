/**
 * The pane's half of talking to a simulator: where a pointer is on the device, and the socket.
 *
 * The frames themselves are built in the contract (`simulator-input.ts`), because the pane is not
 * their only client — the `realm-simulator` input tools send the same frames down the same socket
 * from the server. What stays here is what only a window has: a picture with a box, and a browser
 * WebSocket.
 */

/**
 * A point on the picture → the device's own 0..1 coordinates, or null when it is not on the picture.
 *
 * Measured against the PICTURE's rect rather than the pane's, and that is the whole point: with a
 * frame drawn around the screen, the letterbox is no longer the only thing between the pane's edge
 * and the first device pixel — there is a border too. Arithmetic that centred the picture in the
 * pane would be out by the border's thickness, and a tap that lands 12px from the finger is the
 * failure with no visible symptom, because the picture looks perfectly correct.
 *
 * Against the rect, there is nothing to be out BY: whatever the layout did to the picture, its own
 * box is where the device is. `clamped` is for a drag that has left the picture and still has a
 * touch down — it has to keep reporting, or the device is left holding a press nothing lifts.
 */
export function normalizedPoint(
  rect: { left: number; top: number; width: number; height: number },
  client: { clientX: number; clientY: number },
  clamped: boolean,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (client.clientX - rect.left) / rect.width;
  const y = (client.clientY - rect.top) / rect.height;
  if (clamped) return { x: clamp01(x), y: clamp01(y) };
  return x < 0 || y < 0 || x >= 1 || y >= 1 ? null : { x, y };
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * The socket, with the reconnection a long-lived pane needs.
 *
 * Sends are dropped while the socket is not open rather than queued. A tap is a thing that happened
 * at a moment — replaying one after a reconnect would put a press somewhere the user was no longer
 * looking, which is worse than the tap not landing.
 */
export class SimulatorInput {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly onOpenChange?: (open: boolean) => void) { this.open(); }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.onOpenChange?.(true);
    ws.onclose = () => {
      this.onOpenChange?.(false);
      if (this.closed) return;
      // A stream that was killed and restarted keeps the same URL, so a plain retry is the whole
      // recovery. One second, because this is input rather than pixels — nothing is missed by
      // waiting, and a tight loop against a dead daemon is just noise in the console.
      this.retry = setTimeout(() => this.open(), 1_000);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  send(f: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(f);
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }
}

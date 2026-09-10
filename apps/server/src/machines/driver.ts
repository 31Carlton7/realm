import type { VmAction } from "@realm/contracts";

/**
 * How an agent reaches a machine (Plan 25 W4) — one seam, and the sources behind it differ enough
 * that the seam is the only thing they share.
 *
 * **This is the AGENT's channel, and it is a different socket from the human's.** The pane's RFB
 * connection carries pixels to a canvas at whatever rate the screen changes; this one takes a still
 * frame every few seconds and writes input. Two pipelines, never conflated, so neither can starve or
 * evict the other — which is also why every Realm-booted QEMU gets `-vnc …,share=ignore`, since the
 * default lets a second client evict the first and the human's view must never be interruptible by
 * the agent's.
 *
 * It also means an agent can drive a machine with **no pane open at all**, which is exactly when one
 * is most likely to be working.
 */
export type MachineDriver = {
  /** A PNG of the whole screen, with the framebuffer's own dimensions beside it. */
  screenshot(): Promise<DriverFrame>;
  /** Perform one action. Resolves with what happened, in words a tool result can carry. */
  act(action: VmAction): Promise<string>;
  /** Drop the connection. Called when the machine stops, is deleted, or the server is closing. */
  close(): void;
};

export type DriverFrame = {
  /** PNG bytes. */
  data: Buffer;
  /** The FRAMEBUFFER's size, not the image's — an agent addresses the screen in these, and a
   *  downscaled picture would otherwise teach it a coordinate space that does not exist. */
  width: number;
  height: number;
  /** What the image was actually encoded at, so a tool result can say when it is looking at a
   *  smaller picture than the screen it is clicking on. */
  imageWidth: number;
  imageHeight: number;
};

/** How large a screenshot's longer side may be before it is downscaled.
 *
 *  1280 is chosen against what a model can READ rather than what a screen can hold: below roughly
 *  this, 13px UI text on a 1440-wide desktop stops being legible, and an agent that cannot read a
 *  button's label is an agent guessing at coordinates. Above it the bytes grow with no more
 *  information in them. */
export const SCREENSHOT_MAX_EDGE = 1280;

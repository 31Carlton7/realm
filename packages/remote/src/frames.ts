import { EMPTY } from "./bytes";
import { NoiseError, type CipherState } from "./noise";

/** PROTOCOL.md §5: one Noise transport message per WebSocket binary message, at most 65,535 bytes of
 *  ciphertext. Each plaintext opens with a flag byte — 0x00 ends the application message, 0x01 means
 *  more follow — so a message of any size crosses as a run of frames. */
export const MAX_FRAME = 65_535;
const TAGLEN = 16;
export const MAX_FRAGMENT = MAX_FRAME - TAGLEN - 1;
/** A message the receiver will join before it gives up: generous for a transcript page, small enough
 *  that a hostile peer cannot make the other side hold gigabytes. */
export const MAX_MESSAGE = 16 * 1024 * 1024;

const FINAL = 0x00;
const MORE = 0x01;

/** Seals one application message (JSON text) into one or more frames, in order. */
export function sealMessage(cs: CipherState, json: string): Buffer[] {
  const data = Buffer.from(json, "utf8");
  const frames: Buffer[] = [];
  let off = 0;
  do {
    const fragment = data.subarray(off, off + MAX_FRAGMENT);
    off += fragment.length;
    const flag = off >= data.length ? FINAL : MORE;
    frames.push(cs.encryptWithAd(EMPTY, Buffer.concat([Buffer.from([flag]), fragment])));
  } while (off < data.length);
  return frames;
}

/** Opens frames as they arrive and hands back each complete message's JSON text. */
export class FrameReader {
  private parts: Buffer[] = [];
  private size = 0;

  constructor(private readonly cs: CipherState, private readonly maxMessage = MAX_MESSAGE) {}

  /** The joined message when `frame` completes one; null while more are owed. Throws on a frame that
   *  fails to open or breaks the format — the channel is unusable after that, so the caller closes it. */
  push(frame: Buffer): string | null {
    if (frame.length > MAX_FRAME) throw new NoiseError("frame larger than a Noise message");
    const pt = this.cs.decryptWithAd(EMPTY, frame);
    const flag = pt[0];
    if (flag !== FINAL && flag !== MORE) throw new NoiseError("bad frame flag");
    this.size += pt.length - 1;
    if (this.size > this.maxMessage) throw new NoiseError("message too large");
    this.parts.push(pt.subarray(1));
    if (flag === MORE) return null;
    const text = Buffer.concat(this.parts).toString("utf8");
    this.parts = [];
    this.size = 0;
    return text;
  }
}

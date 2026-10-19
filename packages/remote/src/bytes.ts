/** Small byte helpers shared by the protocol code. Buffers throughout: node:crypto speaks them, and
 *  every key and frame here is a fixed-size byte string rather than text. */

export const EMPTY = Buffer.alloc(0);

export const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

/** base64url without padding — PROTOCOL.md's `b64u`. */
export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** Decodes `b64u`, refusing anything that is not canonical base64url, so a key cannot arrive in two
 *  spellings that compare unequal. */
export function fromB64u(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b = Buffer.from(s, "base64url");
  if (b64u(b) !== s) throw new Error("not canonical base64url");
  return b;
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export const fromHex = (s: string): Buffer => Buffer.from(s, "hex");

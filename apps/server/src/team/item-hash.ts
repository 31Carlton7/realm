import { createHash } from "node:crypto";

/**
 * What a review item's yes covers: sha256 over each file's name and bytes, in order, then the text.
 * One function for Review (which records the hash at approval) and the act tickets (which re-hash the
 * staged bytes before anything goes out), so "what you approved is what was sent" is one definition.
 * `fileHash` answers a file's own sha256, or "missing" — so deleting a file also changes the item.
 */
export function itemHash(files: readonly string[], fileHash: (rel: string) => string, body: string | null): string {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`file:${f}\0`);
    h.update(fileHash(f));
  }
  h.update(`body:${body ?? ""}`);
  return h.digest("hex");
}

export const bytesHash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

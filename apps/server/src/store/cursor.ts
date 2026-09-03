/** The keyset pagination cursor shared by the feed-shaped stores: `${created_at}:${id}`, matching
 *  their `created_at DESC, id DESC` ordering. */
export const encodeCursor = (row: { created_at: number; id: string }): string => `${row.created_at}:${row.id}`;

/** A cursor that does not parse reads as "no cursor" (first page) rather than throwing — it is opaque
 *  client state, and a stale or mangled one should degrade to a fresh listing, not an error. */
export function parseCursor(cursor: string | null): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  if (i <= 0) return null;
  const createdAt = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
}

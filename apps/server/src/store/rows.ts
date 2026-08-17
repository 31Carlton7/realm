export const now = () => Date.now();
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "space";
}
/** An error whose `code` is safe to send to RPC clients. Anything else maps to INTERNAL. */
export class RpcError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export class NotFoundError extends RpcError {
  constructor(what: string, id: string) { super("NOT_FOUND", `${what} ${id} not found`); }
}

export const now = () => Date.now();
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "space";
}
export class NotFoundError extends Error { code = "NOT_FOUND" as const; constructor(what: string, id: string) { super(`${what} ${id} not found`); } }

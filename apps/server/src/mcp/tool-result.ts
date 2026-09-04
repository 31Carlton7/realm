import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
export const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Clips to `n` INCLUDING the ellipsis, so a clipped string never exceeds the caller's budget. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Validate a tool call's arguments, or produce the error result to return as-is. Shared by the
 * gateway providers so an invalid-argument refusal reads the same wherever it comes from.
 */
export function parseArgs<S extends z.ZodTypeAny>(schema: S, raw: unknown): { value: z.infer<S> } | { error: CallToolResult } {
  const r = schema.safeParse(raw);
  return r.success ? { value: r.data } : { error: err(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`) };
}

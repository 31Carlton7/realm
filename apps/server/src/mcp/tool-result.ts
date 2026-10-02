import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
export const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Clips to `n` INCLUDING the ellipsis, so a clipped string never exceeds the caller's budget —
 *  and never between the two halves of an emoji: half of one is text no tokenizer or strict decoder
 *  will take (MEASURED: 125 rows of a Laya training set, and the run refused them all). */
export const clip = (s: string, n: number): string => {
  if (s.length <= n) return s;
  let end = Math.max(0, n - 1);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
};

/**
 * Validate a tool call's arguments, or produce the error result to return as-is. Shared by the
 * gateway providers so an invalid-argument refusal reads the same wherever it comes from.
 */
export function parseArgs<S extends z.ZodTypeAny>(schema: S, raw: unknown): { value: z.infer<S> } | { error: CallToolResult } {
  const r = schema.safeParse(raw);
  return r.success ? { value: r.data } : { error: err(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`) };
}

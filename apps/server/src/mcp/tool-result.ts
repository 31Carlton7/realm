import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
export const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Clips to `n` INCLUDING the ellipsis, so a clipped string never exceeds the caller's budget. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

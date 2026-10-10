import { REALM_TOOL_CLASSES } from "./risk-class";

/**
 * Realm's own gateway tools that change nothing, by the name the gateway lists them under
 * (`<provider>__<tool>`) — ONE list, read by both engines' gates. The gateway marks each of these
 * `annotations.readOnlyHint: true`, which is what Codex reads to skip its own approval; the Claude
 * adapter pre-allows the same names through `allowedTools`. So the two engines agree on which of
 * Realm's tools ask first.
 *
 * Derived from Realm's complete tool table (`REALM_TOOL_CLASSES`): every tool classed `read` that does
 * not still ask first. Why each one is there, and why the reads left out are left out, is written
 * beside the table.
 */
export const REALM_READ_ONLY_TOOLS: readonly string[] = Object.entries(REALM_TOOL_CLASSES)
  .filter(([, c]) => c.class === "read" && !c.asksFirst)
  .map(([name]) => name);

import type { IconName } from "@realm/ui";

/** One-line summary of a tool call's input, per well-known tool; else the first string field. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  switch (name) {
    case "Bash": return str("command") ?? "";
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return str("file_path") ?? str("notebook_path") ?? "";
    case "Glob": case "Grep": return str("pattern") ?? "";
    case "WebFetch": return str("url") ?? "";
    case "WebSearch": return str("query") ?? "";
    case "Task": case "Agent": return str("description") ?? str("prompt") ?? "";
    case "TodoWrite": return "update todos";
    case "exec_command": return str("command") ?? "";
    case "apply_patch": {
      const changes = input["changes"];
      const first = Array.isArray(changes) ? changes[0] : null;
      const path = first && typeof first === "object" ? (first as Record<string, unknown>)["path"] : null;
      return typeof path === "string" ? path : "";
    }
    default: { for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return v; return ""; }
  }
}

export function toolIcon(name: string): IconName {
  switch (name) {
    case "Bash": case "exec_command": return "terminal";
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": case "apply_patch": return "artifact";
    case "Glob": case "Grep": return "search";
    case "WebFetch": case "WebSearch": return "browser";
    case "Task": case "Agent": return "bot";
    default: return "tool";
  }
}

/** Lines in a string the way a diff counts them: 0 for empty, newlines + 1 otherwise. */
const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);

export type EditStat = { add: number; del: number };

/** Measured add/del line counts for a file-editing tool (Plan 9 W2: ThinkingState's `+74 −41`).
 *  Derived from the edit's own payload — the input actually carries both sides of the change, so
 *  the counts are counted, never estimated. Tools whose input does not carry both sides (Read,
 *  Bash, apply_patch envelopes) get null: no counts is honest, invented counts are not. */
export function editStat(name: string, input: Record<string, unknown>): EditStat | null {
  const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  switch (name) {
    case "Edit": {
      const oldS = str(input, "old_string"), newS = str(input, "new_string");
      return oldS === null || newS === null ? null : { add: lineCount(newS), del: lineCount(oldS) };
    }
    case "MultiEdit": {
      const edits = input["edits"];
      if (!Array.isArray(edits)) return null;
      let add = 0, del = 0, counted = false;
      for (const e of edits) {
        if (!e || typeof e !== "object") continue;
        const oldS = str(e as Record<string, unknown>, "old_string"), newS = str(e as Record<string, unknown>, "new_string");
        if (oldS === null || newS === null) continue;
        add += lineCount(newS); del += lineCount(oldS); counted = true;
      }
      return counted ? { add, del } : null;
    }
    case "Write": {
      const content = str(input, "content");
      return content === null ? null : { add: lineCount(content), del: 0 };
    }
    default: return null;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const clip = (s: string, n = 90): string => { const o = oneLine(s); return o.length > n ? `${o.slice(0, n - 1)}…` : o; };
export const prettyJson = (v: unknown): string => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };

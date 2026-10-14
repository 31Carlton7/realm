import type { SessionEvent, SessionEventType, StoredSessionEvent } from "@realm/contracts";
import type { Row } from "@realm/remote";

/**
 * Folds a session's events into the rows a phone draws (PROTOCOL.md §8). Every event kind is named in
 * the switch below with a `never` default, so a kind added to `SessionEventSchema` fails typecheck here
 * until someone decides what the phone shows for it — the phone can never silently drop one.
 *
 * Phase 1's summaries are deliberately small; Phase 2 replaces `summarize` with the desktop's own
 * `toolSummary()`, moved out of the renderer so the two can never disagree.
 */

/** Tools whose card is the request itself — drawing their tool row too would show one thing twice. */
const REQUEST_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const DETAIL_LIMIT = 2_000;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function summarize(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]) => { for (const k of keys) { const v = str(input[k]); if (v) return v; } return null; };
  const line = (s: string) => clip(s.split("\n")[0]!.trim(), 120);
  switch (name) {
    case "Bash": return line(first("command") ?? name);
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return line(first("file_path", "notebook_path", "path") ?? name);
    case "Grep": case "Glob": return line(first("pattern") ?? name);
    case "WebFetch": return line(first("url") ?? name);
    case "WebSearch": return line(first("query") ?? name);
    case "Task": case "Agent": return line(first("description", "prompt") ?? name);
    case "TodoWrite": return "Updated the to-do list";
  }
  for (const v of Object.values(input)) { const s = str(v); if (s) return line(s); }
  return name;
}

type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description?: string }[] };

function questionsOf(input: Record<string, unknown>): Question[] | null {
  if (!Array.isArray(input.questions)) return null;
  const out: Question[] = [];
  for (const q of input.questions as Record<string, unknown>[]) {
    if (!q || typeof q.question !== "string") continue;
    const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]).filter((o) => typeof o?.label === "string").map((o) => ({ label: o.label as string, ...(typeof o.description === "string" ? { description: o.description } : {}) })) : [];
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : "", multiSelect: q.multiSelect === true, options });
  }
  return out;
}

export class SessionProjector {
  /** Insertion order is transcript order; replacing a key keeps its place, which is how a streamed
   *  message or an answered request updates where it stands. */
  private rows = new Map<string, Row>();
  private lastSeq = 0;

  /** The latest persisted seq seen — what a live event must be newer than to count. */
  get seq(): number { return this.lastSeq; }

  all(): Row[] { return [...this.rows.values()]; }

  /** Applies one event (persisted, or ephemeral with seq -1) and returns the rows it changed. */
  apply(stored: StoredSessionEvent): Row[] {
    const ephemeral = stored.seq < 0;
    if (!ephemeral) {
      if (stored.seq <= this.lastSeq) return [];
      this.lastSeq = stored.seq;
    }
    const seq = this.lastSeq;
    const put = (row: Row): Row[] => { this.rows.set(row.key, row); return [row]; };
    const ev = stored.event as SessionEvent;
    const type: SessionEventType = ev.type;
    switch (ev.type) {
      case "user_message": return put({ key: `u:${seq}`, seq, kind: "user", text: ev.payload.text });
      case "assistant_delta": {
        const key = `m:${ev.payload.messageId}`;
        const prev = this.rows.get(key);
        const text = (prev?.kind === "assistant" ? prev.text : "") + ev.payload.delta;
        return put({ key, seq, kind: "assistant", text, streaming: true });
      }
      case "assistant_text": return put({ key: `m:${ev.payload.messageId}`, seq, kind: "assistant", text: ev.payload.text, streaming: false });
      case "thinking": return put({ key: `k:${ev.payload.messageId}`, seq, kind: "thinking", text: ev.payload.text });
      case "tool_call": {
        if (REQUEST_TOOLS.has(ev.payload.name)) return [];
        return put({ key: `t:${ev.payload.toolUseId}`, seq, kind: "tool", name: ev.payload.name, summary: summarize(ev.payload.name, ev.payload.input), state: "running", detail: null });
      }
      case "tool_result": {
        const prev = this.rows.get(`t:${ev.payload.toolUseId}`);
        if (prev?.kind !== "tool") return [];
        return put({ ...prev, seq, state: ev.payload.isError ? "error" : "done", detail: clip(ev.payload.content, DETAIL_LIMIT) });
      }
      case "background_task": return put({ key: `e:${seq}:${ev.payload.toolUseId}`, seq, kind: "notice", text: ev.payload.status === "running" ? "A background task started" : "A background task stopped" });
      case "permission_request": return put({
        key: `r:${ev.payload.requestId}`, seq, kind: "request", requestId: ev.payload.requestId, tool: ev.payload.toolName, title: ev.payload.title,
        summary: summarize(ev.payload.toolName, ev.payload.input), state: "pending", questions: ev.payload.toolName === "AskUserQuestion" ? questionsOf(ev.payload.input) : null,
      });
      case "permission_response": {
        const prev = this.rows.get(`r:${ev.payload.requestId}`);
        if (prev?.kind !== "request") return [];
        return put({ ...prev, seq, state: ev.payload.decision === "deny" ? "denied" : "allowed" });
      }
      case "error": return put({ key: `e:${seq}`, seq, kind: "error", text: ev.payload.message, hint: ev.payload.fix?.hint ?? ev.payload.fix?.title ?? null });
      case "handoff": return put({ key: `e:${seq}`, seq, kind: "notice", text: `Handed over from ${ev.payload.from} to ${ev.payload.to}` });
      case "compacted": return put({ key: `e:${seq}`, seq, kind: "notice", text: "Context compacted" });
      case "context_reset": return put({ key: `e:${seq}`, seq, kind: "notice", text: ev.payload.note || "The agent started a fresh context" });
      case "plan": return put({ key: `p:${ev.payload.planId}`, seq, kind: "plan", text: ev.payload.text ?? null, steps: ev.payload.steps ?? null });
      // The files a turn changed. One line until the phone has a diff view (Plan 28, Phase 4).
      case "turn_changes": {
        const { files, totalFiles } = ev.payload;
        const names = files.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
        const more = totalFiles > 3 ? ", …" : "";
        return put({ key: `c:${ev.payload.checkpointId}`, seq, kind: "notice", text: `Changed ${totalFiles} ${totalFiles === 1 ? "file" : "files"}: ${names}${more}` });
      }
      // The media a turn left behind (screenshots, renders, downloads), one notice per turn. The files
      // stay on the Mac: the row says what was made, by name.
      case "files_made": {
        const { files, totalFiles } = ev.payload;
        const names = files.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
        const more = totalFiles > 3 ? ", …" : "";
        return put({ key: `m:${ev.payload.settledAt}`, seq, kind: "notice", text: `Made ${totalFiles} ${totalFiles === 1 ? "file" : "files"}: ${names}${more}` });
      }
      // Carried elsewhere, or not drawn on the phone in Phase 1: status travels as `session.status`;
      // usage, init, feedback and the account's rate limits are desktop detail; the summary and the
      // suggested reply arrive with the Phase 2 composer.
      case "status": case "usage": case "init": case "feedback": case "summary": case "prompt_hint": case "retrying": case "rate_limit":
        return [];
      default: {
        const unhandled: never = ev;
        return put({ key: `e:${seq}:${type}`, seq, kind: "unknown", type: String((unhandled as { type: string }).type) });
      }
    }
  }
}

import type { AskCard, AskQuestion, QueuedPrompt, SessionEvent, SessionEventType, StoredSessionEvent } from "@realm/contracts";
import { givenAttachmentName } from "@realm/contracts/src/temp-attachments";
import type { QueuedMessage, Row } from "@realm/remote";
import { questionOf } from "@realm/view";

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
/** A plan is read on the phone, not glanced at, so it keeps far more than a tool's detail does. */
const PLAN_LIMIT = 32_000;

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

type RequestRow = Extract<Row, { kind: "request" }>;
type Question = NonNullable<RequestRow["questions"]>[number];
type PlanRow = Extract<Row, { kind: "plan" }>;

/** A yes-or-no question carries no options on its card; the desktop draws Yes and No, and so does
 *  this, so a phone that knows no `confirm` can still answer one. */
const CONFIRM_OPTIONS = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }];

/** One of the card's questions, in the phone's shape: what Phase 1 sent, and what the card adds. */
function questionRow(q: AskQuestion): Question {
  const options = q.kind === "confirm" && !q.options?.length ? CONFIRM_OPTIONS
    : (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}), ...(o.value !== o.label ? { value: o.value } : {}) }));
  return {
    question: q.prompt, header: q.header ?? "", multiSelect: q.kind === "multi", options,
    id: q.id, kind: q.kind, allowOther: q.allowOther === true, secret: q.secret === true,
    ...(q.required ? { required: true } : {}), ...(q.detail ? { detail: q.detail } : {}),
    ...(q.placeholder ? { placeholder: q.placeholder } : {}), ...(q.default !== undefined ? { default: q.default } : {}),
  };
}

/** A message waiting in the Mac's queue, as its user row will read once it goes out: each file named as
 *  the person named it, without the prefix a phone's or a paste's file was written under. */
export function queuedMessage(q: QueuedPrompt, attachmentsDir: string | null): QueuedMessage {
  return {
    id: q.id, text: q.text, at: q.ts, held: q.held,
    attachments: q.attachments.map((a) => ({ path: a.path, name: givenAttachmentName(a.path, attachmentsDir), mime: a.mime })),
  };
}

/** Who asks, as the desktop's card names them: the agent, or a server by the name the person gave it. */
const askerOf = (card: AskCard): string => (card.asker.kind === "server" ? `${card.asker.name}'s MCP server` : card.asker.name);

export class SessionProjector {
  /** Insertion order is transcript order; replacing a key keeps its place, which is how a streamed
   *  message or an answered request updates where it stands. */
  private rows = new Map<string, Row>();
  private lastSeq = 0;
  /** The newest plan the agent kept, which a plan's approval carries. */
  private lastPlan: PlanRow | null = null;
  /** The suggested next message, the desktop's way: the newest `prompt_hint`, until a message is sent. */
  private hinted: { text: string; throughSeq: number } | null = null;

  /** `attachmentsDir` is the Realm home's `tmp/attachments`: a file there was written under a random
   *  prefix, which a row leaves out of its name. */
  constructor(private readonly o: { attachmentsDir: string | null } = { attachmentsDir: null }) {}

  /** The latest persisted seq seen — what a live event must be newer than to count. */
  get seq(): number { return this.lastSeq; }

  /** The suggested next message, or null. */
  get hint(): string | null { return this.hinted?.text ?? null; }

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
      // Anything sent makes the suggestion about a turn that is no longer the last one. What was sent
      // with it stays on the Mac: the row names each file as the person named it, and `session.file`
      // previews one.
      case "user_message": {
        this.hinted = null;
        const files = ev.payload.attachments.map((a) => ({ path: a.path, name: givenAttachmentName(a.path, this.o.attachmentsDir), mime: a.mime }));
        return put({ key: `u:${seq}`, seq, kind: "user", text: ev.payload.text, ...(files.length ? { attachments: files } : {}) });
      }
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
      case "permission_request": {
        // A question is told apart by Realm's own card, as the desktop tells it (`questionOf`); one
        // Realm declined itself is nobody's to answer.
        const asked = questionOf(ev.payload);
        const card = asked && asked.refused === undefined ? asked : null;
        const { input } = ev.payload;
        return put({
          key: `r:${ev.payload.requestId}`, seq, kind: "request", requestId: ev.payload.requestId, tool: ev.payload.toolName, title: ev.payload.title,
          summary: summarize(ev.payload.toolName, input), state: "pending", questions: card ? card.questions.map(questionRow) : null,
          ...(card ? { asker: askerOf(card), ...(card.message ? { message: card.message } : {}) } : {}),
          ...(ev.payload.toolName === "ExitPlanMode" ? { plan: {
            text: typeof input.plan === "string" ? clip(input.plan, PLAN_LIMIT) : this.lastPlan?.text ?? null,
            steps: this.lastPlan?.steps ?? null,
          } } : {}),
        });
      }
      case "permission_response": {
        const prev = this.rows.get(`r:${ev.payload.requestId}`);
        if (prev?.kind !== "request") return [];
        return put({ ...prev, seq, state: ev.payload.decision === "deny" ? "denied" : "allowed", ...(ev.payload.answers ? { answers: ev.payload.answers } : {}) });
      }
      case "error": return put({ key: `e:${seq}`, seq, kind: "error", text: ev.payload.message, hint: ev.payload.fix?.hint ?? ev.payload.fix?.title ?? null });
      case "handoff": return put({ key: `e:${seq}`, seq, kind: "notice", text: `Handed over from ${ev.payload.from} to ${ev.payload.to}` });
      case "compacted": return put({ key: `e:${seq}`, seq, kind: "notice", text: "Context compacted" });
      case "context_reset": return put({ key: `e:${seq}`, seq, kind: "notice", text: ev.payload.note || "The agent started a fresh context" });
      case "plan": {
        const row: PlanRow = { key: `p:${ev.payload.planId}`, seq, kind: "plan", text: ev.payload.text ?? null, steps: ev.payload.steps ?? null };
        this.lastPlan = row;
        return put(row);
      }
      // The files a turn changed, in one line; `session.changes` opens them by the checkpoint.
      case "turn_changes": {
        const { files, totalFiles } = ev.payload;
        const names = files.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
        const more = totalFiles > 3 ? ", …" : "";
        return put({ key: `c:${ev.payload.checkpointId}`, seq, kind: "notice", text: `Changed ${totalFiles} ${totalFiles === 1 ? "file" : "files"}: ${names}${more}`, checkpointId: ev.payload.checkpointId });
      }
      // The media a turn left behind (screenshots, renders, downloads), one notice per turn. The files
      // stay on the Mac: the row names them, and `session.file` previews one.
      case "files_made": {
        const { files, totalFiles } = ev.payload;
        const names = files.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
        const more = totalFiles > 3 ? ", …" : "";
        return put({ key: `m:${ev.payload.settledAt}`, seq, kind: "notice", text: `Made ${totalFiles} ${totalFiles === 1 ? "file" : "files"}: ${names}${more}`, files: files.map((f) => ({ path: f.path, size: f.size })) });
      }
      // Forward only, as the desktop's prompter has it: a hint written for an earlier turn can land
      // after a newer one, and the newer one wins. It is no row; `session.hint` carries it.
      case "prompt_hint":
        if (!this.hinted || this.hinted.throughSeq <= ev.payload.throughSeq) this.hinted = { text: ev.payload.text, throughSeq: ev.payload.throughSeq };
        return [];
      // Carried elsewhere, or not drawn on the phone: status travels as `session.status`; usage, init,
      // feedback and the account's rate limits are desktop detail, and so is the summary.
      case "status": case "usage": case "init": case "feedback": case "summary": case "retrying": case "rate_limit":
        return [];
      default: {
        const unhandled: never = ev;
        return put({ key: `e:${seq}:${type}`, seq, kind: "unknown", type: String((unhandled as { type: string }).type) });
      }
    }
  }
}

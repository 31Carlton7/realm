import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { obj, str } from "../bag";


/** Text out of an ACP ContentBlock; non-text blocks render as a short marker. */
function blockText(block: unknown): string {
  const b = obj(block);
  switch (str(b.type)) {
    case "text": return str(b.text);
    case "image": return "[image]";
    case "audio": return "[audio]";
    case "resource_link": return `[${str(b.name) || str(b.uri)}]`;
    case "resource": return `[resource ${str(obj(b.resource).uri)}]`;
    default: return "";
  }
}

/** ToolCallContent[] → a single string for Realm's `tool_result.content`. */
function renderToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((raw) => {
    const c = obj(raw);
    switch (str(c.type)) {
      case "content": return blockText(c.content);
      case "diff": return unifiedDiff(str(c.path), c.oldText === null || c.oldText === undefined ? null : str(c.oldText), str(c.newText));
      case "terminal": return `[terminal ${str(c.terminalId)}]`;
      default: return "";
    }
  }).filter(Boolean).join("\n");
}

const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * An ACP `diff` content block as a unified diff — the form the transcript draws a change in and
 * counts it from. ACP sends the two whole texts; the lines they share at either end are context,
 * and what is between them is the change, as one hunk. For an edit that changed one stretch of a
 * file that is exactly git's answer; for one that changed two stretches it counts the unchanged
 * lines between them as replaced, which is the most this has to go on without a diff of its own.
 * `oldText: null` is a new file.
 */
function unifiedDiff(path: string, oldText: string | null, newText: string): string {
  const a = lines(oldText ?? ""), b = lines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const del = a.slice(head, a.length - tail), add = b.slice(head, b.length - tail);
  return [`--- ${oldText === null ? "/dev/null" : path}`, `+++ ${path}`,
    `@@ -${del.length ? head + 1 : head},${del.length} +${add.length ? head + 1 : head},${add.length} @@`,
    ...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`)].join("\n");
}

/** The files an ACP call names (`locations`), for the transcript's row. */
function locationsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((l) => str(obj(l).path)).filter((p) => p !== "") : [];
}

/** ACP's `plan` entries — `{content, priority, status}` with status `pending | in_progress |
 *  completed` (docs/dev/acp-protocol.md:182), which is already Realm's spelling. An unrecognised
 *  status reads as `pending`: it must never render as work already done. `priority` is carried by
 *  the protocol and deliberately not by Realm — the card is an ordered checklist, and a field only
 *  one agent in ten ever sets would be blank everywhere else.
 *
 *  Entries with no content are dropped rather than drawn as blank rows. */
function planSteps(raw: unknown): { text: string; status: "pending" | "in_progress" | "completed" }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const status = str(obj(e).status);
    return { text: str(obj(e).content), status: status === "completed" ? "completed" as const : status === "in_progress" ? "in_progress" as const : "pending" as const };
  }).filter((e) => e.text !== "");
}

/** The merged state of one ACP tool call. `input`/`kind` feed §4 permission-card rendering. */
export type AcpCall = { title: string; kind: string; input: Record<string, unknown>; done: boolean };

/**
 * Pure, stateful mapper from ACP `session/update` payloads to Realm SessionEvents.
 *
 * ACP has no message ids and no end-of-message marker, so a contiguous run of `agent_message_chunk`s is grouped
 * under one generated id: every chunk emits an ephemeral `assistant_delta`, and the run is flushed to a single
 * persisted `assistant_text` when any other update arrives or the turn ends. Thought runs work identically, minus
 * the deltas — Realm's `thinking` event has no streaming variant. Agents interleave thought and message chunks
 * freely, so a chunk of either kind closes an open run of the other.
 *
 * `tool_call_update` is a SPARSE PATCH — only `toolCallId` is guaranteed and other fields are optional AND
 * nullable, so a missing field must never clear stored state.
 */
export function createAcpMapper() {
  const calls = new Map<string, AcpCall>();
  let msg: { id: string; text: string } | null = null;
  let thought: { id: string; text: string } | null = null;
  /** Identity for THIS turn's plan. ACP's plan "is not incremental: replace the whole list each
   *  time", so every update inside a turn has to land on the same card; a new turn gets a new one,
   *  because overwriting the last turn's plan would erase what the agent set out to do. */
  let planId: string | null = null;

  // At most one of `msg`/`thought` is ever open: each chunk branch cross-flushes the other before opening its own
  // run, so the order of the two blocks below is unobservable — they never both fire in the same call.
  const flushRuns = (): SessionEvent[] => {
    const out: SessionEvent[] = [];
    if (msg) { if (msg.text) out.push(sessionEvent("assistant_text", { messageId: msg.id, text: msg.text })); msg = null; }
    if (thought) { if (thought.text) out.push(sessionEvent("thinking", { messageId: thought.id, text: thought.text })); thought = null; }
    return out;
  };

  return {
    map(rawUpdate: unknown): SessionEvent[] {
      const u = obj(rawUpdate);
      const kind = str(u.sessionUpdate);

      if (kind === "agent_message_chunk") {
        const text = blockText(u.content);
        const out: SessionEvent[] = [];
        if (thought) out.push(...flushRuns());
        if (!msg) msg = { id: newId(), text: "" };
        msg.text += text;
        out.push(sessionEvent("assistant_delta", { messageId: msg.id, delta: text }));
        return out;
      }

      if (kind === "agent_thought_chunk") {
        const text = blockText(u.content);
        const out: SessionEvent[] = [];
        if (msg) out.push(...flushRuns());
        if (!thought) thought = { id: newId(), text: "" };
        thought.text += text;
        return out;
      }

      const out = flushRuns();

      if (kind === "tool_call") {
        const id = str(u.toolCallId);
        const call: AcpCall = { title: str(u.title) || id, kind: str(u.kind) || "other", input: obj(u.rawInput), done: false };
        calls.set(id, call);
        // What the agent said, never the "other" this mapper files an unstated kind under.
        const paths = locationsOf(u.locations);
        out.push(sessionEvent("tool_call", { toolUseId: id, name: call.title, input: call.input, parentToolUseId: null,
          ...(str(u.kind) ? { kind: str(u.kind) } : {}), ...(paths.length ? { paths } : {}) }));
        return out;
      }

      if (kind === "tool_call_update") {
        const id = str(u.toolCallId);
        const call = calls.get(id) ?? { title: id, kind: "other", input: {}, done: false };
        // Sparse patch: only overwrite fields that are actually present.
        if (typeof u.title === "string") call.title = u.title;
        if (typeof u.kind === "string") call.kind = u.kind;
        if (u.rawInput !== undefined && u.rawInput !== null) call.input = obj(u.rawInput);
        calls.set(id, call);
        const status = str(u.status);
        if ((status === "completed" || status === "failed") && !call.done) {
          call.done = true;
          const body = renderToolContent(u.content);
          const raw = u.rawOutput === undefined || u.rawOutput === null ? "" : JSON.stringify(u.rawOutput);
          out.push(sessionEvent("tool_result", { toolUseId: id, content: body || raw, isError: status === "failed" }));
        }
        return out;
      }

      if (kind === "plan") {
        const steps = planSteps(u.entries);
        if (!steps.length) return out;
        planId ??= newId();
        out.push(sessionEvent("plan", { planId, steps }));
        return out;
      }

      // available_commands_update / current_mode_update / user_message_chunk are parsed and dropped.
      return out;
    },

    /** Flush any open text runs — call on prompt resolution, cancellation, and dispose.
     *  Also ends the turn's plan: the NEXT turn's plan is a new card, not an overwrite of this one.
     *  Deliberately not in `flushRuns`, which every non-chunk update calls — resetting there would
     *  give a plan a fresh card for every tool call between its revisions. */
    flush(): SessionEvent[] { const out = flushRuns(); planId = null; return out; },

    /** Close any tool call still open, e.g. when the child dies mid-turn. */
    closeOpenCalls(reason: string): SessionEvent[] {
      const out: SessionEvent[] = [];
      for (const [id, call] of calls) {
        if (call.done) continue;
        call.done = true;
        out.push(sessionEvent("tool_result", { toolUseId: id, content: reason, isError: true }));
      }
      return out;
    },

    /**
     * The merged state held for a call. `session/request_permission` carries a `ToolCallUpdate` where only
     * `toolCallId` is guaranteed (protocol reference §4), so the adapter renders its card from this, not the patch.
     */
    callOf(id: string): Readonly<AcpCall> | undefined { return calls.get(id); },

    /** Visible for tests: the merged title currently held for a call. */
    titleOf(id: string): string | undefined { return calls.get(id)?.title; },
  };
}

import { sessionEvent, windowLabelForMinutes, type SessionEvent } from "@realm/contracts";
import { obj, str, type Bag } from "../bag";

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Item types Realm renders as a tool card, and the tool name it shows. */
function toolNameFor(item: Bag): string | null {
  switch (str(item.type)) {
    case "commandExecution": return "exec_command";
    case "fileChange": return "apply_patch";
    case "mcpToolCall": return `${str(item.server) || "mcp"}.${str(item.tool) || "tool"}`;
    case "dynamicToolCall": case "collabAgentToolCall": case "webSearch": return str(item.type);
    default: return null;
  }
}

function toolInputFor(item: Bag): Record<string, unknown> {
  switch (str(item.type)) {
    case "commandExecution": return { command: str(item.command), cwd: str(item.cwd) };
    case "fileChange": return { changes: item.changes ?? [] };
    case "mcpToolCall": return obj(item.arguments);
    default: { const { id: _id, type: _type, ...rest } = item; return rest; }
  }
}

function toolOutputFor(item: Bag): string {
  switch (str(item.type)) {
    case "commandExecution": {
      const out = str(item.aggregatedOutput);
      const code = item.exitCode;
      return typeof code === "number" && code !== 0 ? `${out}\n[exit ${code}]`.trim() : out;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Bag[]) : [];
      return changes.map((c) => `${str(obj(c.kind).type) || "change"} ${str(c.path)}\n${str(c.diff)}`.trimEnd()).join("\n\n");
    }
    case "mcpToolCall": {
      const err = str(item.error);
      if (err) return err;
      return typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? null);
    }
    default: return JSON.stringify(item);
  }
}

/** Realm's plan-step status from Codex's `TurnPlanStepStatus` — `"pending" | "inProgress" |
 *  "completed"` (`codex app-server generate-ts`, codex 0.146.0). Anything else reads as `pending`:
 *  a status Realm does not recognise must never render as work already done. */
const planStatus = (v: unknown): "pending" | "in_progress" | "completed" =>
  v === "completed" ? "completed" : v === "inProgress" ? "in_progress" : "pending";

/** `turn/plan/updated`'s `plan: TurnPlanStep[]`, each `{step, status}`. Steps with no text are
 *  dropped rather than rendered as blank rows; an empty result means there is no plan to show. */
function planSteps(raw: unknown): { text: string; status: "pending" | "in_progress" | "completed" }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => ({ text: str(obj(e).step), status: planStatus(obj(e).status) })).filter((e) => e.text !== "");
}

/**
 * Pure, stateful mapper from `codex app-server` notifications to Realm SessionEvents.
 *
 * - Codex's `userMessage` item is dropped: SessionService already emits `user_message` on send.
 * - Reasoning is emitted once, on `item/completed`, because Realm's `thinking` event has no delta variant.
 * - Open tool items are force-closed on `turn/completed`; an interrupt never sends their `item/completed`.
 * - Open message/reasoning runs are flushed to their persisted event there too, for the same reason: an
 *   interrupt stops in-flight items dead, and `assistant_delta` is ephemeral.
 * - Advisory notifications return `[]` — the adapter logs them instead of putting them in the transcript.
 */
export function createCodexMapper() {
  /** itemIds of tool items still awaiting item/completed. */
  const openTools = new Set<string>();
  /** Delta text accumulated for message and reasoning items still awaiting item/completed. */
  const openText = new Map<string, string>();
  const openThought = new Map<string, string>();
  /** Delta text accumulated for `plan` items still awaiting item/completed — see flushOpenRuns. */
  const openPlan = new Map<string, string>();
  let numTurns = 0;
  /** The thread's service tier as Codex last reported it — `undefined` until it has said anything,
   *  which is the honest reading of "not stated" rather than "off". Codex writes the tier a
   *  `turn/start` asked for back onto the thread and announces it before the turn begins, so this is
   *  what the harness DID, not what the session asked for. */
  let serviceTier: string | null | undefined;

  /**
   * Persists whatever a message or reasoning item streamed before it stopped.
   *
   * `assistant_delta` is ephemeral — not in PERSISTED_EVENT_TYPES — and the persisted `assistant_text` only
   * ever comes from `item/completed`, which an interrupt never sends (protocol reference §8). Without this the
   * streamed answer is visible live and gone after a reload.
   */
  const flushOpenRuns = (): SessionEvent[] => {
    const out: SessionEvent[] = [];
    for (const [id, text] of openText) if (text) out.push(sessionEvent("assistant_text", { messageId: id, text }));
    for (const [id, text] of openThought) if (text) out.push(sessionEvent("thinking", { messageId: id, text }));
    // The plan an interrupt cut short. `item/plan/delta` is flagged EXPERIMENTAL and its own doc
    // comment says clients must not assume concatenated deltas match the completed item — but an
    // item that never completes has no completed content to differ from, and the concatenation is
    // the only record there will be. That is why these deltas are never emitted live.
    for (const [id, text] of openPlan) if (text) out.push(sessionEvent("plan", { planId: id, text }));
    openText.clear();
    openThought.clear();
    openPlan.clear();
    return out;
  };

  return {
    map(method: string, rawParams: unknown): SessionEvent[] {
      const p = obj(rawParams);
      const out: SessionEvent[] = [];

      switch (method) {
        case "item/started": {
          const item = obj(p.item);
          const id = str(item.id);
          const type = str(item.type);
          // No Realm event of their own, but the run has to be open before its first delta can be kept.
          if (type === "agentMessage") { openText.set(id, ""); return out; }
          if (type === "reasoning") { openThought.set(id, ""); return out; }
          if (type === "plan") { openPlan.set(id, ""); return out; }
          const name = toolNameFor(item);
          if (name) { openTools.add(id); out.push(sessionEvent("tool_call", { toolUseId: id, name, input: toolInputFor(item), parentToolUseId: null })); }
          return out; // userMessage starts carry no Realm event
        }

        case "item/completed": {
          const item = obj(p.item);
          const id = str(item.id);
          const type = str(item.type);
          // Clearing the run is what keeps the flush from persisting a normal message a second time.
          if (type === "agentMessage") { openText.delete(id); out.push(sessionEvent("assistant_text", { messageId: id, text: str(item.text) })); return out; }
          // The `plan` ThreadItem is `{id, text}` — prose, not the step list `turn/plan/updated`
          // carries. Both are plans and neither is derived from the other, so each gets its own card.
          if (type === "plan") {
            openPlan.delete(id);
            const text = str(item.text);
            if (text) out.push(sessionEvent("plan", { planId: id, text }));
            return out;
          }
          if (type === "reasoning") {
            openThought.delete(id);
            const summary = Array.isArray(item.summary) ? (item.summary as unknown[]).map(str) : [];
            const content = Array.isArray(item.content) ? (item.content as unknown[]).map(str) : [];
            const text = [...summary, ...content].filter(Boolean).join("\n\n");
            if (text) out.push(sessionEvent("thinking", { messageId: id, text }));
            return out;
          }
          if (openTools.has(id)) {
            openTools.delete(id);
            out.push(sessionEvent("tool_result", { toolUseId: id, content: toolOutputFor(item), isError: str(item.status) !== "completed" }));
          }
          return out;
        }

        case "item/agentMessage/delta": {
          const id = str(p.itemId);
          const delta = str(p.delta);
          openText.set(id, (openText.get(id) ?? "") + delta);
          return [sessionEvent("assistant_delta", { messageId: id, delta })];
        }

        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta": {
          // Accumulated but never emitted: Realm's `thinking` event has no streaming variant, so these only
          // exist so an interrupted reasoning item still has something to persist.
          const id = str(p.itemId);
          openThought.set(id, (openThought.get(id) ?? "") + str(p.delta));
          return [];
        }

        case "item/plan/delta": {
          // Accumulated, never emitted: see flushOpenRuns for why the completed item is the truth.
          const id = str(p.itemId);
          openPlan.set(id, (openPlan.get(id) ?? "") + str(p.delta));
          return [];
        }

        case "turn/plan/updated": {
          // Keyed on the TURN, not the notification: Codex re-sends the whole plan every time a step
          // moves, so a revision has to replace the card already drawn. `plan:` keeps that id out of
          // the item-id space the prose plans above use.
          const steps = planSteps(p.plan);
          return steps.length ? [sessionEvent("plan", { planId: `plan:${str(p.turnId)}`, steps })] : [];
        }

        case "item/commandExecution/outputDelta":
          // Streamed stdout. Realm has no partial-tool-result event in v1; the full output arrives on item/completed.
          return [];

        case "turn/started":
          numTurns += 1;
          return [];

        case "turn/completed": {
          const turn = obj(p.turn);
          const status = str(turn.status);
          // An item still open here never got its own item/completed (an interrupt skips it entirely) — that
          // goes for the turn's message and reasoning runs as much as for its tool calls.
          out.push(...flushOpenRuns());
          for (const id of openTools) out.push(sessionEvent("tool_result", { toolUseId: id, content: status === "interrupted" ? "interrupted" : `turn ended without a result (${status})`, isError: true }));
          openTools.clear();
          if (status === "failed") out.push(sessionEvent("error", { message: str(obj(turn.error).message) || "turn failed" }));
          out.push(sessionEvent("status", { status: "idle" }));
          return out;
        }

        case "thread/status/changed": {
          const t = str(obj(p.status).type);
          if (t === "active") return [sessionEvent("status", { status: "running" })];
          if (t === "idle") return [sessionEvent("status", { status: "idle" })];
          if (t === "systemError") return [sessionEvent("status", { status: "error" })];
          return [];
        }

        case "thread/tokenUsage/updated": {
          const usage = obj(p.tokenUsage);
          const total = obj(usage.total);
          // What the window is CARRYING, as against what the thread has SPENT. `last` is the most
          // recent request, so its prompt is every message, tool result and instruction the model
          // still had in front of it — the one figure here that falls when Codex drops history.
          // `total` beside it is thread-cumulative and passes the window on any long thread while
          // saying nothing about how full it is. Codex's `inputTokens` already counts the cached
          // part (the protocol capture's 120 includes its own 20 cached), so nothing is added to it.
          const resident = num(obj(usage.last).inputTokens);
          const window = num(usage.modelContextWindow);
          return [sessionEvent("usage", { costUsd: 0, inputTokens: num(total.inputTokens), outputTokens: num(total.outputTokens), numTurns,
            ...(resident > 0 && window > 0 ? { contextTokens: resident, contextWindow: window } : {}),
            // The fifth fact off the same sample, the way Claude's result carries `fast_mode_state`:
            // present only once Codex has named a tier at all. Codex has no reason codes — a tier it
            // will not serve is refused at `turn/start`, which is already an error in the transcript.
            ...(serviceTier === undefined ? {} : { fastMode: serviceTier === "priority" ? "on" as const : "off" as const }) })];
        }

        /**
         * The account's plan quota. Captured live from codex-cli 0.154.0 — see
         * docs/dev/codex-app-server-protocol.md §3 for the verbatim payload.
         *
         * Three things about the real shape that the code has to respect:
         *
         *  - `resetsAt` is epoch SECONDS here, where Claude's stream reports milliseconds. Multiplied
         *    once, at the edge, so everything above this line holds one unit.
         *  - `primary` / `secondary` are POSITIONS, not durations. The duration lives beside them in
         *    `windowDurationMins` (300 and 10080 as measured), so the label is read off that — which
         *    is what makes Codex's two windows line up with the 5-hour and weekly ones Claude names.
         *  - `planType` was the literal string `"unknown"` on a live ChatGPT account, not a tier. It
         *    is only carried through when it says something, so the card reads "plan not reported"
         *    rather than "Codex Unknown".
         *
         * `rateLimitReachedType` is the only status Codex offers, and it reports a limit ALREADY hit.
         * There is no approaching-the-limit signal on this wire, so `alert` never becomes
         * "approaching" for Codex — see PLAN_LIMIT_REPORTING's `warns: false`.
         */
        case "account/rateLimits/updated": {
          const limits = obj(p.rateLimits);
          const windows = (["primary", "secondary"] as const).flatMap((slot) => {
            const w = obj(limits[slot]);
            if (typeof w.usedPercent !== "number") return [];
            return [{
              id: slot,
              label: windowLabelForMinutes(num(w.windowDurationMins)),
              utilization: w.usedPercent,
              resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
            }];
          });
          const reached = str(limits.rateLimitReachedType) || null;
          const planType = str(limits.planType);
          return [sessionEvent("rate_limit", {
            subscriptionType: planType && planType !== "unknown" ? planType : null,
            organization: null,
            windows,
            alert: reached ? "exceeded" : "none",
            // The slot Codex names, when it names one, so the row it belongs to is the row that tones.
            alertWindow: reached === "primary" || reached === "secondary" ? reached : null,
            unavailable: null,
            detail: reached,
          })];
        }

        case "thread/settings/updated": {
          const settings = obj(p.threadSettings);
          if ("serviceTier" in settings) serviceTier = str(settings.serviceTier) || null;
          return [];
        }

        case "error": {
          const message = str(obj(p.error).message) || "agent error";
          return [sessionEvent("error", { message: p.willRetry === true ? `${message} (retrying)` : message })];
        }

        default:
          return []; // advisory + firehose notifications; the adapter logs them
      }
    },

    /** Close anything still open — used when the process dies mid-turn or the session is disposed. */
    closeOpenTools(reason: string): SessionEvent[] {
      const out = flushOpenRuns();
      for (const id of openTools) out.push(sessionEvent("tool_result", { toolUseId: id, content: reason, isError: true }));
      openTools.clear();
      return out;
    },
  };
}

/**
 * Background sub-agents, read off the harness's own task protocol.
 *
 * A background `Agent`/`Task` call is not a tool call that stays open: it returns within a second
 * and the agent then works for minutes. So "the result has not arrived yet" — the signal a blocking
 * sub-agent gives — is false for a background one's entire life, and ten of them look exactly like
 * ten finished calls.
 *
 * What the harness does emit, on the same stream as everything else, is a set of `system` messages
 * about its tasks. Captured live (Claude Code 2.1.258) and pinned in `fixtures/background-tasks.json`:
 *
 *   - `task_started` — `{task_id, tool_use_id, description, subagent_type, is_backgrounded,
 *     spawn_depth, task_type, prompt}`, plus `owned_by_subagent` when a SUB-agent started it.
 *   - `task_progress` — periodic, with `usage` and `last_tool_name`.
 *   - `task_notification` — `{task_id, tool_use_id, status, output_file, summary}` when it stops.
 *   - `task_updated` — `{task_id, patch:{status, end_time}}`. No `tool_use_id`, so it cannot be
 *     attributed to a call in the transcript, and is deliberately not read here.
 *   - `background_tasks_changed` — the full live set, but its entries carry only
 *     `{task_id, task_type, description}`. Also no `tool_use_id`. It is the better shape in the
 *     abstract — a snapshot cannot leave an orphan the way a start/stop pair can — and it is not
 *     used for exactly that missing field: `tool_use_id` is what ties a row to the call that made
 *     it, which is the row's label, its start time and the card it scrolls to.
 *
 * Everything here fails closed. An unrecognized message is nothing at all, and the dock falls back
 * to listing only the blocking sub-agents it listed before — the failure that loses a feature rather
 * than the one that shows a run which is not there.
 */

/** What one of these messages means to Realm, or null if it means nothing. */
export type BackgroundTaskSignal = { toolUseId: string; status: "running" | "stopped"; summary?: string };

export function backgroundTaskFrom(msg: unknown): BackgroundTaskSignal | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; subtype?: unknown; tool_use_id?: unknown; summary?: unknown; is_backgrounded?: unknown; task_type?: unknown; owned_by_subagent?: unknown };
  if (m.type !== "system") return null;
  const toolUseId = typeof m.tool_use_id === "string" && m.tool_use_id ? m.tool_use_id : null;
  if (!toolUseId) return null;

  if (m.subtype === "task_started") {
    // Three conditions, and each excludes something real that was seen on the wire:
    //  - `is_backgrounded` false is a BLOCKING sub-agent, which the dock already tracks by its call
    //    staying open. Marking it here as well would put it in both lists at once.
    //  - `task_type` is `local_bash` for a backgrounded shell command. A running command is not an
    //    agent, and a dock that counted them would say "3 agents" about one agent and two sleeps.
    //  - `owned_by_subagent` means a sub-agent started it, not this session — the same rule the dock
    //    applies to nested tool calls, which are the parent task's business and not a second row.
    if (m.is_backgrounded !== true || m.task_type !== "local_agent" || m.owned_by_subagent === true) return null;
    return { toolUseId, status: "running" };
  }

  if (m.subtype === "task_notification") {
    // Deliberately unfiltered, unlike the start above: a notification is only ever acted on if it
    // names a call already marked running, so the nested bash task's own notification — which the
    // live capture shows arriving with a real `tool_use_id` — lands on a block that was never
    // running and changes nothing. Filtering here too would be a second copy of that rule.
    const summary = typeof m.summary === "string" && m.summary.trim() ? m.summary.trim() : undefined;
    return { toolUseId, status: "stopped", ...(summary ? { summary } : {}) };
  }

  return null;
}

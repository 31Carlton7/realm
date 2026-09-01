import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { EVENTS_MAX, arr, clipTool, clipToolInput, fallbackTitle, rec, readJsonl, str, toMs, type ParsedTranscript } from "./transcript";

/**
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — the Claude CLI's own transcript, one JSON
 * object per line.
 *
 * The line types that matter are `user` and `assistant`, each wrapping an Anthropic API message whose
 * `content` is either a bare string or a block list (`text` / `thinking` / `tool_use` / `tool_result`
 * / `image`). Everything else on the file is CLI bookkeeping — `ai-title`, `custom-title`,
 * `queue-operation`, `attachment`, `mode`, `last-prompt`, `pr-link`, `file-history-snapshot` and a
 * dozen more that come and go between releases — and is skipped by omission rather than by an
 * exclusion list, so a type added by a future CLI version cannot break the parse.
 *
 * The two title lines ARE read, because they are the CLI's own answer to "what is this conversation",
 * and a hand-set title beats anything derived from the first message.
 */
export function parseClaudeTranscript(text: string, now: number): ParsedTranscript | null {
  const { rows } = readJsonl(text);
  const events: SessionEvent[] = [];
  let sessionId = "", cwd = "", model: string | null = null;
  let aiTitle = "", customTitle = "";
  let startedAt = 0, updatedAt = 0, messages = 0;
  let truncated = false;

  for (const row of rows) {
    const type = str(row.type);
    // Identity is repeated on nearly every line; the first line to carry it wins, and later lines
    // cannot move it. A resumed session keeps its original id and cwd, which is what makes the id a
    // stable dedup key across re-scans.
    if (!sessionId) sessionId = str(row.sessionId);
    if (!cwd) cwd = str(row.cwd);
    if (type === "ai-title") { aiTitle = str(row.aiTitle) || aiTitle; continue; }
    if (type === "custom-title") { customTitle = str(row.customTitle) || customTitle; continue; }
    if (type !== "user" && type !== "assistant") continue;
    // A sidechain line is a SUBAGENT's turn, interleaved into the parent file. Realm models a
    // delegated agent as its own session, so folding these into the parent transcript would
    // attribute a subagent's words to the main conversation. Skipped, not merged.
    if (row.isSidechain === true) continue;

    const msg = rec(row.message);
    const ts = toMs(row.timestamp, updatedAt || now);
    if (!startedAt) startedAt = ts;
    updatedAt = Math.max(updatedAt, ts);
    if (!model) { const m = str(msg.model); if (m) model = m; }
    const messageId = str(msg.id) || str(row.uuid) || `import-${events.length}`;

    const content = msg.content;
    // A bare string is the API's short form for a single text block, and the CLI still writes it for
    // ~1400 user turns in this corpus. Normalised here so the block loop below is the only reader.
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : arr(content);

    for (const raw of blocks) {
      const b = rec(raw);
      const kind = str(b.type);
      if (kind === "text") {
        const t = str(b.text);
        if (t.trim() === "") continue;
        if (type === "user") { events.push(sessionEvent("user_message", { text: t, attachments: [] }, ts)); messages++; }
        else { events.push(sessionEvent("assistant_text", { messageId, text: t }, ts)); messages++; }
      } else if (kind === "thinking") {
        const t = str(b.thinking) || str(b.text);
        if (t.trim() !== "") events.push(sessionEvent("thinking", { messageId, text: t }, ts));
      } else if (kind === "tool_use") {
        events.push(sessionEvent("tool_call", {
          toolUseId: str(b.id) || messageId, name: str(b.name) || "tool",
          input: clipToolInput(b.input), parentToolUseId: null,
        }, ts));
      } else if (kind === "tool_result") {
        events.push(sessionEvent("tool_result", {
          toolUseId: str(b.tool_use_id), content: clipTool(toolResultText(b.content)), isError: b.is_error === true,
        }, ts));
      } else if (kind === "image") {
        // An image block has no text to carry and Realm's `user_message` attachments want a real
        // path, which the transcript does not keep (the bytes are inline base64). Recorded as a
        // one-line placeholder so the turn is not silently missing from the imported conversation.
        events.push(sessionEvent(type === "user" ? "user_message" : "assistant_text",
          type === "user" ? { text: "[image]", attachments: [] } : { messageId, text: "[image]" }, ts));
      }
    }
    if (events.length >= EVENTS_MAX) { truncated = true; break; }
  }

  if (!sessionId || events.length === 0) return null;
  if (truncated) {
    events.push(sessionEvent("error", {
      message: `Realm imported the first ${EVENTS_MAX.toLocaleString("en-US")} events of this transcript; the rest is still in the source file.`,
    }, updatedAt || now));
  }
  return {
    providerSessionId: sessionId,
    cwd,
    title: customTitle || aiTitle || fallbackTitle(events),
    events, messages,
    startedAt: startedAt || now,
    updatedAt: updatedAt || startedAt || now,
    // The Claude CLI records `entrypoint` (`sdk-ts` when a program drove it) but not WHICH program,
    // and Realm's own live checks show up under `claude-desktop` too — so there is no field here
    // that honestly says "Realm made this". Reported false; the database dedup on
    // `providerSessionId` is what actually keeps Realm's own sessions from being re-imported.
    fromRealm: false,
    model,
  };
}

/** A `tool_result` block's content: a string, or the API's block-list form. Non-text blocks in that
 *  list (images) are named rather than dropped, so a result that was mostly a screenshot does not
 *  import as an empty string. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content).map((raw) => {
    const b = rec(raw);
    return str(b.type) === "text" ? str(b.text) : `[${str(b.type) || "content"}]`;
  }).join("\n");
}

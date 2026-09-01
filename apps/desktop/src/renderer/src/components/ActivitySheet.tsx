import { Icon } from "@realm/ui";
import type { McpCall, Session } from "@realm/contracts";
import { useState } from "react";
import { useApp } from "../state/store";
import { Sheet } from "./Sheet";
import { relTime } from "./CommandPalette";

/**
 * "87ms" / "1.2s" — deliberately more precise than the tool-run ledger's `formatDuration`
 * (panes/session/tool-group.ts), which rounds to whole seconds and says "<1s" for anything under one.
 * A gateway round-trip is usually sub-second, and "<1s" would tell a reader nothing about whether a
 * call was fast or slow — which is exactly the thing Activity exists to show at a glance.
 *
 * Blocked calls log `durationMs: 0` (they never reached an upstream server, so there is nothing to
 * time) — rendered as "—", never "0ms", which would read as an implausibly fast successful call. A
 * genuine sub-millisecond local stdio call is also 0 and gets the same "—", which is not quite honest
 * for that case — an accepted conflation, since the gateway's own clock is ms-resolution and a "0ms"
 * label would be indistinguishable noise either way.
 */
function formatCallDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * `server__tool`, or the bare tool name for the blocked-call attribution quirk the plan's W3-review
 * amendment calls out: a call blocked before it could be matched to a known server logs
 * `serverName: ""` with `tool` already holding the full namespaced string, so prefixing it again would
 * double it up into `__realserver__tool`.
 */
function callLabel(call: McpCall): string {
  return call.serverName ? `${call.serverName}__${call.tool}` : call.tool;
}

/** `argsJson` pretty-printed for the expanded row. `resultSummary` is never run through anything like
 *  this — see the render site below — because the gateway already sanitizes it and a raw args blob has
 *  no such guarantee attached; pretty-printing is purely a display nicety, not a re-validation. Falls
 *  back to the raw string on malformed JSON rather than throwing — a log viewer must never crash on a
 *  row it is only trying to display. */
function prettyArgs(argsJson: string): string {
  try { return JSON.stringify(JSON.parse(argsJson), null, 2); }
  catch { return argsJson; }
}

const TRUNCATED_ID_LEN = 8;

/**
 * A session's title if the store still has it, else a truncated id.
 *
 * `sessions` (state/store.ts) is only ever the ACTIVE space's sessions — refreshSessions scopes it that
 * way, same as `environments`/`projects`. `mcp.call` broadcasts arrive for every space's sessions
 * (binding rule 5), so a call from another space, or from a session whose item has since been deleted,
 * has nothing to resolve against here. Falling back to a truncated id rather than hiding the row is the
 * accepted v1 gap named in the plan — a full session browser is out of scope for a call log.
 */
function sessionLabel(sessionId: string, sessions: Record<string, Session>): string {
  return sessions[sessionId]?.title ?? `${sessionId.slice(0, TRUNCATED_ID_LEN)}…`;
}

/**
 * Realm's log of every proxied MCP call (Plan 9 W7) — reverse-chronological, filterable by session and
 * server, live-updating from the `mcp.call` broadcast App.tsx subscribes to.
 *
 * Opened from McpSection's "Activity" button (opening over the space page it lives inside — the
 * one-slot ruling) and the command palette's "MCP Activity" entry, both through `openActivity`, which
 * always resets to the unfiltered view: this is a global log, not a per-space one, so nothing here is
 * scoped to whatever space the sheet happened to be opened from.
 */
export function ActivitySheet() {
  const calls = useApp((s) => s.mcpCalls);
  const filter = useApp((s) => s.mcpCallsFilter);
  const hasMore = useApp((s) => s.mcpCallsHasMore);
  const sessions = useApp((s) => s.sessions);
  const mcpServers = useApp((s) => s.mcpServers);
  const setMcpCallsFilter = useApp((s) => s.setMcpCallsFilter);
  const loadMoreMcpCalls = useApp((s) => s.loadMoreMcpCalls);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Session chips come ONLY from loaded rows — a chip for a session with zero calls would be a dead
  // end. Server chips add the store's known servers on top (plan wording): a server that hasn't logged
  // a call yet is still worth narrowing to once it does, and McpSection's "Activity" entry point means
  // `mcpServers` is often already populated with exactly the servers the user came here to look at.
  const sessionChips: [string, string][] = [];
  const seenSessions = new Set<string>();
  for (const c of calls) {
    if (seenSessions.has(c.sessionId)) continue;
    seenSessions.add(c.sessionId);
    sessionChips.push([c.sessionId, sessionLabel(c.sessionId, sessions)]);
  }
  const serverChips = new Map<string, string>();
  for (const c of calls) if (c.serverId) serverChips.set(c.serverId, c.serverName || c.serverId);
  for (const s of mcpServers) serverChips.set(s.id, s.name);

  const isFiltered = !!(filter.sessionId || filter.serverId);

  return (
    <Sheet title="Activity" onClose={closeSheet} width={640}>
      <div className="form">
        {(sessionChips.length > 0 || serverChips.size > 0) && (
          <div className="activity-filters">
            {sessionChips.length > 0 && (
              <div className="activity-filter-group">
                <span className="env-kind">Session</span>
                {sessionChips.map(([id, label]) => (
                  <button key={id} type="button" className="btn-quiet chip-filter" aria-pressed={filter.sessionId === id}
                    onClick={() => run(() => setMcpCallsFilter({ sessionId: filter.sessionId === id ? null : id }))}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {serverChips.size > 0 && (
              <div className="activity-filter-group">
                <span className="env-kind">Server</span>
                {[...serverChips].map(([id, name]) => (
                  <button key={id} type="button" className="btn-quiet chip-filter" aria-pressed={filter.serverId === id}
                    onClick={() => run(() => setMcpCallsFilter({ serverId: filter.serverId === id ? null : id }))}>
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {calls.length === 0
          ? (
            <p className="env-empty">
              {isFiltered ? "No calls match these filters." : "No MCP calls yet — calls agents make through Realm's gateway appear here."}
            </p>
          )
          : (
            <ul className="activity-list">
              {calls.map((c) => (
                <li key={c.id} className="activity-row">
                  <button type="button" className="tool-row activity-row-main" aria-expanded={expanded.has(c.id)} onClick={() => toggle(c.id)}>
                    <span className="activity-time">{relTime(c.ts)}</span>
                    <span className="activity-session">{sessionLabel(c.sessionId, sessions)}</span>
                    <span className="activity-call">{callLabel(c)}</span>
                    <span className="activity-duration">{formatCallDuration(c.durationMs)}</span>
                    {/* Same ok/error visual language as a session's own tool cards (ToolCard.tsx): a
                        muted check when settled fine, the danger color only for an actual failure. */}
                    <span className="activity-status" data-ok={c.ok} aria-label={c.ok ? "ok" : "error"}>
                      <Icon name={c.ok ? "check" : "errorCircle"} size={14} />
                    </span>
                  </button>
                  {expanded.has(c.id) && (
                    <div className="activity-detail">
                      <div className="field"><span>Arguments</span><pre className="tool-well">{prettyArgs(c.argsJson)}</pre></div>
                      {/* Verbatim, per the binding rule: the gateway already sanitized this — re-parsing
                          or reformatting it here would be pretending Realm knows something it doesn't. */}
                      <div className="field"><span>Result</span><pre className="tool-well">{c.resultSummary}</pre></div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

        {hasMore && (
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn-quiet" onClick={() => run(() => loadMoreMcpCalls())}>Load more</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

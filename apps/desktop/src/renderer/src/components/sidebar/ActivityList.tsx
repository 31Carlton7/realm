import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import type { Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { callLabel, formatCallDuration, sessionLabel } from "../ActivitySheet";
import { relTime } from "../CommandPalette";

/**
 * The gateway's call log, in the sidebar's own column and in the sidebar's own rows.
 *
 * It stands where the space's list stands, because it answers the same shape of question — what has
 * been going on here — and a feed you watch while working cannot be a modal over the thing you are
 * working on. The rows are the sidebar's rows: one line, a glyph, a name that ellipsizes, a quiet
 * figure at the trailing edge. Nothing here is a card, because a call is a thing you count.
 *
 * Grouped by the SESSION and the SERVER, rather than listed flat. The sidebar's grammar is a heading
 * and its rows, and both of those facts read identically on every row of a burst — so they are said
 * once, in the heading, and the row carries only the tool. A row that spelled out
 * `realm-browser__browser_snapshot` in 240px spent the width on the half that never varies and
 * ellipsized the half that does; the full name stays on the tooltip and the accessible name, which
 * is where a string that repeats down a column belongs.
 *
 * The full log — the filters, the arguments, what came back — stays in the sheet, reached from ⌘K and
 * from a space's Connections tab. This is the glance; that is the record.
 */
export function ActivityList() {
  const calls = useApp((s) => s.mcpCalls);
  const hasMore = useApp((s) => s.mcpCallsHasMore);
  const sessions = useApp((s) => s.sessions);
  const loadMore = useApp((s) => s.loadMoreMcpCalls);
  const listAllSessions = useApp((s) => s.listAllSessions);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  /* `revealSession`, not `openSession`: the pane has to come FORWARD, and the call may have come
     from a session in another space — which it handles by switching there first. */
  const revealSession = useApp((s) => s.revealSession);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const refreshMcpCalls = useApp((s) => s.refreshMcpCalls);
  const run = useApp((s) => s.run);
  /* The feed reads the log itself rather than being handed it. Flipping the lens only clears the
     rows and any filter; one mount is one fetch, wherever the mount came from. */
  useEffect(() => { run(() => refreshMcpCalls()); }, [refreshMcpCalls, run]);

  /* Every session in the home, by id — the Agents page's own read, for the Agents page's own reason.
     The log spans spaces and `sessions` holds only the active one, so against a real log half the
     headings came back as `01M267WY…`: a truncated id where a title belongs, for a session that has
     one and that `revealSession` can reach. Local state, like the Agents page's rows: this is a
     snapshot for naming, not a second copy of the store's session map. */
  const [known, setKnown] = useState<Record<string, Session>>({});
  useEffect(() => {
    let live = true;
    run(async () => {
      const all = await listAllSessions();
      if (live) setKnown(Object.fromEntries(all.map((x) => [x.id, x])));
    });
    return () => { live = false; };
  }, [listAllSessions, run]);

  // Runs of consecutive calls from one session to one server, in the order the calls came back —
  // which is newest first, so the headings read down the page in the same direction the rows do.
  // Not a group-by: a session that was busy, went quiet, and came back is two runs, and collapsing
  // them would put an hour-old call under a heading whose newest row is a second old.
  const runs: { sessionId: string; server: string; calls: typeof calls }[] = [];
  for (const c of calls) {
    const last = runs[runs.length - 1];
    if (last && last.sessionId === c.sessionId && last.server === c.serverName) last.calls.push(c);
    else runs.push({ sessionId: c.sessionId, server: c.serverName, calls: [c] });
  }

  /* A session's own title wherever the home still has the row. `sessionLabel`'s truncated id stays
     as the last resort, which now means only what it should: a session that has been deleted while
     its calls remain in the log. */
  const nameOf = (sessionId: string) => known[sessionId]?.title ?? sessionLabel(sessionId, sessions);
  const spaceOf = (sessionId: string) => known[sessionId]?.spaceId ?? sessionSpace[sessionId] ?? null;

  if (calls.length === 0) {
    return (
      <div className="space-body sb-activity sb-activity-blank">
        <div className="sb-activity-empty">
          <Icon name="activity" size={20} />
          <p className="sb-activity-empty-line">No calls yet</p>
          <p className="sb-activity-empty-sub">Tool calls agents make through Realm's gateway show up here, newest first.</p>
          {/* The shortest honest path to a call happening: the servers this space can reach. Which of
              the two reasons the log is empty — nothing connected, or nothing used yet — is not
              something this view can know, and the page answers both. */}
          <button type="button" className="btn" onClick={() => openDestinationPage("connections-page")}>Manage connections</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-body sb-activity">
      {runs.map((r, i) => (
        <div key={`${r.sessionId}-${i}`}>
          <div className="group-label sb-activity-head">
            <span className="sb-activity-session">{nameOf(r.sessionId)}</span>
            {/* Absent rather than blank for a call blocked before the gateway could attribute it: its
                tool name already carries the namespace it was refused under. */}
            {r.server && <span className="sb-activity-server">{r.server}</span>}
          </div>
          <div className="item-list">
            {r.calls.map((c) => (
              <div key={c.id} className="item">
                {/* Every other row in this column opens the thing it names, and "where did this call
                    come from" is what a feed row raises. A call from a session the store cannot even
                    NAME has nothing to open, so that row is inert rather than a button whose only
                    outcome is nothing happening. */}
                <button className="item-row" disabled={!known[c.sessionId] && !sessions[c.sessionId]}
                  aria-label={`${callLabel(c)} — ${c.ok ? "ok" : "failed"}, ${formatCallDuration(c.durationMs)}, ${relTime(c.ts)}`}
                  title={`${callLabel(c)}\n${relTime(c.ts)} · ${formatCallDuration(c.durationMs)}${c.ok ? "" : "\nFailed"}`}
                  onClick={() => run(() => revealSession(c.sessionId, spaceOf(c.sessionId)))}>
                  <Icon name="tool" size={16} />
                  <span className="item-title activity-call">{c.tool}</span>
                  <span className="activity-duration">{formatCallDuration(c.durationMs)}</span>
                  {/* A mark for a FAILURE only. Every row wearing a tick is a column of chrome saying
                      what the absence of a cross already says, and the state is in the accessible
                      name either way — the glyph is never the only carrier. */}
                  {!c.ok && <span className="activity-status" data-ok={false}><Icon name="errorCircle" size={12} /></span>}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {hasMore && (
        <button className="group-new" onClick={() => run(() => loadMore())}>
          <Icon name="arrowDown" size={12} /><span>Older calls</span>
        </button>
      )}
    </div>
  );
}

import { AGENT_META } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { REALM_NEW_SESSION_TYPE } from "../drag-types";
import { SidebarToggle } from "./SidebarToggle";
import { useChord } from "./use-sidebar-model";

/**
 * The sidebar's head row, in the traffic lights' 40px band: its own toggle, search and a new session,
 * at the column's far end (Plan 27, as Codex lays its top row out).
 *
 * The row's start belongs to the window, not the column: the lights and back and forward sit there
 * whether or not there is a sidebar (WindowLead), and this row's content is clipped clear of them as
 * it slides (`.sb-header`). The profile is the column's first row under it (`.sb-title`).
 *
 * A new session goes into the space you are in — today's room, the space of the session in focus.
 * Each space's section offers its own + on hover, and Quick chat is a keystroke rather than a row.
 */
export function SidebarHeader() {
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  // The tooltip names the agent you will actually get: the last one used, else Realm's fallback.
  const agent = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const run = useApp((s) => s.run);
  const search = useChord("palette.toggle");
  const newSession = useChord("session.new");
  const [dragging, setDragging] = useState(false);
  return (
    <div className="sb-header">
      <span className="sb-header-actions">
        <SidebarToggle />
        <button type="button" className="icon-btn" aria-label="Search" title={search ? `Search (${search})` : "Search"}
          onClick={() => setPaletteOpen(true)}><Icon name="search" size={14} /></button>
        {/* Draggable as the old row was: dropped on a pane, it puts a new session there. */}
        <button type="button" className="icon-btn" aria-label="New session" title={`New ${AGENT_META[agent].label} session${newSession ? ` (${newSession})` : ""}`}
          draggable data-dragging={dragging || undefined}
          onDragStart={(e) => { e.dataTransfer.setData(REALM_NEW_SESSION_TYPE, "new-session"); e.dataTransfer.effectAllowed = "copy"; setDragging(true); }}
          onDragEnd={() => setDragging(false)}
          onClick={() => run(() => newSessionInstant())}><Icon name="edit" size={14} /></button>
      </span>
    </div>
  );
}

import { AGENT_META } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { REALM_NEW_SESSION_TYPE } from "../drag-types";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { useChord } from "./use-sidebar-model";

/**
 * The sidebar's head row, in the same 40px band as the traffic lights beside it: the profile, then
 * search and a new session (Plan 27).
 *
 * A new session goes into the space you are in — today's room, the space of the session in focus.
 * Each space's section offers its own + on hover, and Quick chat is a keystroke rather than a row.
 * The profile's name is the one thing here of unbounded length, so it is what gives way to the two
 * glyphs; neither of them ever shrinks.
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
      <ProfileSwitcher />
      <span className="sb-header-actions">
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

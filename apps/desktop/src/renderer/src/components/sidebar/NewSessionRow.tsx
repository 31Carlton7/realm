import { AGENT_META } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { REALM_NEW_SESSION_TYPE } from "../drag-types";

/**
 * The sidebar's "+" (W3). It replaces the old NewItemMenu: creating a session asks nothing, so there is
 * no menu to open and no sheet behind it — one click makes the session and lands in the hero prompter,
 * It renders as the sidebar's FIRST row, under the search field (Ara refresh §5 — Ara's "New chat").
 * where the agent/model/permission chips carry every choice.
 *
 * Terminals kept their own routes (space menu → New terminal, ⌘T, palette), so nothing was orphaned by
 * dropping the menu; the browser-tab placeholder went with it rather than living on as a dead row.
 */
export function NewSessionRow() {
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const agent = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const run = useApp((s) => s.run);
  const [dragging, setDragging] = useState(false);
  return (
    <div className="new-item" draggable data-dragging={dragging || undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData(REALM_NEW_SESSION_TYPE, "new-session");
        e.dataTransfer.effectAllowed = "copy";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}>
      <button className="item-row new-row" aria-label="New session" title={`New ${AGENT_META[agent].label} session (⌘N)`}
        onClick={() => run(() => newSessionInstant())}><Icon name="edit" size={16} /><span>New session</span></button>
    </div>
  );
}

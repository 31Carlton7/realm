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
  const openQuickChat = useApp((s) => s.openQuickChat);
  const quickChatOpen = useApp((s) => s.quickChat !== null);
  const agent = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const run = useApp((s) => s.run);
  const [dragging, setDragging] = useState(false);
  return (
    <>
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
      {/* OUTSIDE the draggable wrapper, which is not a detail: dragging that wrapper means "put a new
          session in this pane", and a quick chat is the one session that has no pane to be put in.
          Inside it, every press on this row that moved a pixel would have created something else. */}
      {/* Its EQUAL, and drawn as one: same height, same ink, stacked flush against it. The two are
          the same verb aimed at different occasions — a session takes a pane and rearranges the
          workspace, which is right when the answer is the work; a quick chat floats over whatever is
          already there, which is right when the answer is a paragraph you wanted without putting
          anything down. That is a thing to pick between, not a hierarchy to descend, and the row
          that was drawn a rung quieter to say so read as a sub-item of the one above it instead. */}
      <button className="item-row quick-row" aria-label="Quick chat" aria-pressed={quickChatOpen}
        title="A small chat window over your work — no pane, and closing it deletes the chat"
        onClick={() => run(() => openQuickChat())}><Icon name="session" size={16} /><span>Quick chat</span></button>
    </>
  );
}

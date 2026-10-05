import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { TerminalView } from "../TerminalPane";
import { TerminalMark, terminalTitle, useTerminalPrograms } from "../../components/ProgramMark";
import { DOCK_H_TERMINAL, dockPinMinPaneHeight, useDockDismiss, useDockPinned, usePaneRect } from "./pane-dock";

/**
 * The session's terminal docked along the pane's BOTTOM edge, where Settings ▸ General ▸ Terminals
 * puts it on request: the layout people bring from an editor, and the one a tall, narrow pane can
 * afford. Its default place is a tab of the session's side pane, which the pane bar's button opens
 * itself; this dock is drawn only for the Bottom choice.
 *
 * A card by the dock's rules: it pins when the pane can spare the HEIGHT, and the pane then gives up
 * its foot, which lifts the prompter above the shell rather than under it; in a short pane it floats
 * over the foot instead. Escape closes it.
 *
 * The pty is untouched by any of this. Closing the dock neither kills the shell nor clears its
 * scrollback — `ensureSessionTerminal` is get-or-create, so re-opening lands back in the same
 * session, which is what makes a terminal safe to treat as a panel you dismiss.
 */
export function TerminalDock({ sessionId, title, visible, anchorRef, onClose }: {
  sessionId: string;
  title: string;
  visible: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalId = useApp((s) => s.sessionTerminals[sessionId]);
  const programOf = useTerminalPrograms(!!terminalId);
  const shown = terminalId ? terminalTitle(title, programOf(terminalId)) : title;
  const rect = usePaneRect(anchorRef);
  const pinned = (rect?.height ?? 0) >= dockPinMinPaneHeight(DOCK_H_TERMINAL);
  useDockPinned(rect, pinned, "--terminal-dock-h", "bottom");
  /* `anchorRef` is the whole pane, so it cannot be in `keepOpenIn` — every click in the transcript
     would count as inside and nothing would dismiss. The bar's toggle does not need listing either:
     it TOGGLES, so a click there closes by its own route. Same reasoning as SubagentPanel's. */
  useDockDismiss({ pinned, onClose, keepOpenIn: [ref] });

  return createPortal(
    <div ref={ref} className="terminal-dock pane-dock" role="dialog" aria-label={`Terminal for ${title}`}
      data-pinned={pinned || undefined}
      style={{ position: "fixed", left: rect?.left ?? 0, right: rect?.right ?? 0, bottom: rect?.bottom ?? 0 }}>
      <header className="terminal-dock-bar">
        {terminalId
          ? <TerminalMark terminalId={terminalId} size={14} className="terminal-dock-mark" />
          : <Icon name="terminal" size={14} className="terminal-dock-mark" />}
        <span className="terminal-dock-title" title={shown}>{shown}</span>
        {/* A ×, not the trash the sub-agent view wears: there IS something under this one that
            closing keeps. The shell goes on running with its scrollback, and the next open returns
            to it — so promising to preserve it is a promise this button can keep (design.md). */}
        <button type="button" className="icon-btn" aria-label="Hide terminal" title="Hide (⌘J)" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <TerminalOccupant sessionId={sessionId} title={title} visible={visible} />
    </div>,
    document.body,
  );
}

/** Get-or-create on mount, so a shell this session already has is re-attached rather than replaced,
 *  and a session that has never opened one gets it started here. */
function TerminalOccupant({ sessionId, title, visible }: { sessionId: string; title: string; visible: boolean }) {
  const terminalId = useApp((s) => s.sessionTerminals[sessionId]);
  const ensureSessionTerminal = useApp((s) => s.ensureSessionTerminal);
  const run = useApp((s) => s.run);
  useEffect(() => { if (!terminalId) run(() => ensureSessionTerminal(sessionId)); }, [terminalId, sessionId, ensureSessionTerminal, run]);
  return terminalId
    ? <TerminalView terminalId={terminalId} title={title} visible={visible} />
    : <div className="terminal-pane"><div className="terminal-hint"><div className="terminal-hint-path">Starting shell…</div></div></div>;
}

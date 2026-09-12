import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { TerminalView } from "../TerminalPane";
import { DOCK_W_TERMINAL, dockPinMinPane, useDockDismiss, useDockPinned, usePaneRect } from "./pane-dock";

/**
 * The session's terminal, on the same right-hand strip the summary and the sub-agent view use.
 *
 * It used to be an internal `PanelGroup` split with a draggable divider, which read as the pane
 * having been cut in half — a second permanent column with its own seam, for a shell most turns
 * never need. The strip already existed for exactly this shape of thing: a surface opened from the
 * pane bar, read beside the transcript, and finished with. Moving the terminal onto it means one
 * place in a pane can be occupied at a time and one set of rules governs all three (pin when the
 * pane can spare the width, float when it cannot, Escape closes).
 *
 * Wider than its neighbours (`DOCK_W_TERMINAL`), because a terminal is the one dock whose content
 * has a minimum honest width: the summary is prose that reflows, and a shell is columns that wrap.
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
  const rect = usePaneRect(anchorRef);
  const pinned = (rect?.width ?? 0) >= dockPinMinPane(DOCK_W_TERMINAL);
  useDockPinned(rect, pinned, "--terminal-dock-w");
  /* `anchorRef` is the whole pane, so it cannot be in `keepOpenIn` — every click in the transcript
     would count as inside and nothing would dismiss. The bar's toggle does not need listing either:
     it TOGGLES, so a click there closes by its own route. Same reasoning as SubagentPanel's. */
  useDockDismiss({ pinned, onClose, keepOpenIn: [ref] });

  return createPortal(
    <div ref={ref} className="terminal-dock pane-dock" role="dialog" aria-label={`Terminal for ${title}`}
      data-pinned={pinned || undefined}
      style={{ position: "fixed", right: rect?.right ?? 0, top: rect?.top ?? 0,
        "--dock-pane-h": `${rect?.height ?? window.innerHeight}px` } as React.CSSProperties}>
      <header className="terminal-dock-bar">
        <Icon name="terminal" size={14} className="terminal-dock-mark" />
        <span className="terminal-dock-title" title={title}>{title}</span>
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

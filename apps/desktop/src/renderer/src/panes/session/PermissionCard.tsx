import { Icon } from "@realm/ui";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PermissionDecision } from "../../state/store";
import type { PendingPermission } from "./transcript-model";
import { clip, prettyJson, toolIcon, toolSummary } from "./tool-summary";

/** The agent wants to run a tool: Allow (once) / Allow always / Deny.
 *
 *  Keyboard (U-H4): with `autoFocus` (the card sits in the focused pane) the Allow button takes
 *  focus on mount, so a bare Enter answers the hottest question in the app. Inside the card:
 *  Enter = Allow, ⇧Enter = Allow always, ⌘⌫ = Deny — handled on keydown with preventDefault so a
 *  focused button never double-fires its native Enter click. Buttons keep exact accessible names
 *  ("Allow", not "Allow ⏎") via aria-label; the kbd hints are visual only. */
export function PermissionCard({ permission, onDecide, autoFocus = false, enter = false }: {
  permission: PendingPermission; onDecide: (d: PermissionDecision) => void; autoFocus?: boolean; enter?: boolean;
}) {
  const summary = clip(toolSummary(permission.toolName, permission.input), 200);
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (autoFocus) allowRef.current?.focus(); }, [autoFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      // A focused control wins over the card's default: Enter on the Deny button must mean Deny,
      // never the card-level Allow (security inversion). Buttons are activated explicitly (with
      // preventDefault, so the browser's own Enter→click never double-fires); Enter on the details
      // <summary> is left entirely to native toggle semantics and decides nothing.
      const control = e.target instanceof HTMLElement ? e.target.closest("button, summary") : null;
      if (control instanceof HTMLButtonElement) { e.preventDefault(); control.click(); return; }
      if (control) return;
      e.preventDefault(); onDecide(e.shiftKey ? "allow_always" : "allow");
    } else if (e.key === "Backspace" && e.metaKey) { e.preventDefault(); onDecide("deny"); }
  };

  return (
    <div className="permission-card" role="group" aria-label="Permission request" data-enter={enter || undefined} onKeyDown={onKeyDown}>
      <div className="permission-head"><Icon name="alert" size={15} /><span>{permission.title}</span></div>
      <div className="permission-tool"><Icon name={toolIcon(permission.toolName)} size={14} /><span className="tool-name">{permission.toolName}</span>{summary && <code>{summary}</code>}</div>
      <details className="permission-details"><summary>Input</summary><pre>{prettyJson(permission.input)}</pre></details>
      <div className="permission-actions">
        <button className="btn" aria-label="Deny" onClick={() => onDecide("deny")}>Deny <kbd>⌘⌫</kbd></button>
        <button className="btn" aria-label="Allow always" onClick={() => onDecide("allow_always")}>Allow always <kbd>⇧⏎</kbd></button>
        <button ref={allowRef} className="btn primary" aria-label="Allow" onClick={() => onDecide("allow")}>Allow <kbd>⏎</kbd></button>
      </div>
    </div>
  );
}

import { Icon } from "@realm/ui";
import { useState } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";

/** Divider + "New…" row at the bottom of a space's item list. */
export function NewItemMenu() {
  const newTerminal = useApp((s) => s.newTerminal);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  return (
    <div className="new-item">
      <div className="sb-divider" />
      <div className="menu-anchor">
        <button className="item-row new-row" aria-label="New item" onClick={() => setOpen((o) => !o)}><Icon name="add" size={14} /><span>New…</span></button>
        {open && (
          <Menu label="New item" onClose={() => setOpen(false)} items={[
            { label: "Session…", disabled: true, title: "Agent sessions arrive with Part B", onSelect: () => {} },
            { label: "Terminal", onSelect: () => run(() => newTerminal()) },
            { label: "Browser tab", disabled: true, title: "Coming in Plan 4", onSelect: () => {} },
          ]} />
        )}
      </div>
    </div>
  );
}

import { Icon } from "@realm/ui";
import { useCallback, useRef, useState } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";

/** Divider + "New…" row at the bottom of a space's item list. */
export function NewItemMenu() {
  const newTerminal = useApp((s) => s.newTerminal);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="new-item">
      <div className="sb-divider" />
      <button ref={btnRef} className="item-row new-row" aria-label="New item" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}><Icon name="add" size={14} /><span>New…</span></button>
      {open && (
        <Menu label="New item" onClose={close} anchorRef={btnRef} items={[
          { label: "Session…", onSelect: () => openSheet({ kind: "new-session" }) },
          { label: "Terminal", onSelect: () => run(() => newTerminal()) },
          { label: "Browser tab — on the roadmap", disabled: true, onSelect: () => {} },
        ]} />
      )}
    </div>
  );
}

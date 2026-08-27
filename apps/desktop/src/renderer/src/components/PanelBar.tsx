import { Icon } from "@realm/ui";
import { useRef, useState, type ReactNode } from "react";
import type { Item } from "@realm/contracts";
import { paneMeta } from "../panes/registry";
import { useApp } from "../state/store";
import { Menu } from "./Menu";
import { RenameInput } from "./RenameInput";

const hinted = (label: string, keys: string): ReactNode => <><span>{label}</span><kbd className="menu-kbd">{keys}</kbd></>;

/** Slim per-panel header: item icon + click-to-rename title, per-kind meta (right), ⋯ menu + close.
 *  Split/close stay leaf-scoped callbacks (the host owns focus semantics); rename/delete are
 *  item-scoped and go straight to the store, like the sidebar's context menu. */
export function PanelBar({ item, onSplit, onClose }: {
  item: Item; onSplit: (dir: "row" | "col") => void; onClose: () => void;
}) {
  const deleteItem = useApp((s) => s.deleteItem);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Two-step destructive confirm (U-H2), same pattern as the sidebar's item menu.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const Meta = paneMeta[item.kind];
  const closeMenu = () => { setMenuOpen(false); setConfirmingDelete(false); };
  return (
    <div className="panel-bar">
      <span className="panel-icon"><Icon name={item.kind} size={14} /></span>
      {renaming
        ? <span className="panel-rename"><RenameInput item={item} onDone={() => setRenaming(false)} /></span>
        : (
          <button className="panel-title" title="Click to rename" aria-label={`Rename ${item.title}`}
            onClick={() => setRenaming(true)}>{item.title}</button>
        )}
      <span className="panel-meta">{Meta ? <Meta item={item} /> : null}</span>
      <span className="panel-actions">
        <button ref={menuBtn} className="icon-btn" aria-label={`Pane menu for ${item.title}`} aria-haspopup="menu"
          aria-expanded={menuOpen} title="Pane menu" onClick={() => { setConfirmingDelete(false); setMenuOpen(true); }}>
          <Icon name="more" size={13} />
        </button>
        <button className="icon-btn" aria-label={`Close ${item.title}`} title="Close (⌘W)" onClick={onClose}><Icon name="close" size={13} /></button>
      </span>
      {menuOpen && (
        <Menu anchorRef={menuBtn} align="right" label={`Actions for ${item.title}`} onClose={closeMenu} items={[
          { label: "Rename", onSelect: () => setRenaming(true) },
          { kind: "separator" },
          { label: hinted("Split right", "⌘\\"), onSelect: () => onSplit("row") },
          { label: hinted("Split down", "⌘⇧\\"), onSelect: () => onSplit("col") },
          { label: hinted("Close", "⌘W"), onSelect: onClose },
          { kind: "separator" },
          confirmingDelete
            ? { label: <strong>Really delete?</strong>, danger: true, onSelect: () => run(() => deleteItem(item.id)) }
            : { label: "Delete", danger: true, keepOpen: true, onSelect: () => setConfirmingDelete(true) },
        ]} />
      )}
    </div>
  );
}

import { Icon } from "@realm/ui";
import { useRef, useState } from "react";
import type { Item } from "@realm/contracts";
import { paneActions, paneMeta } from "../panes/registry";
import { useApp } from "../state/store";
import { Menu } from "./Menu";
import { RenameInput } from "./RenameInput";

/** Slim per-panel header: item icon + click-to-rename title, per-kind meta (right), ⋯ menu + close.
 *  Split/close/focus stay leaf-scoped callbacks (the host owns focus semantics); rename/delete are
 *  item-scoped and go straight to the store, like the sidebar's context menu. */
export function PanelBar({ item, onSplit, onClose, zoomed = false, onZoom, onUnzoom }: {
  item: Item; onSplit: (dir: "row" | "col") => void; onClose: () => void;
  /** This pane is the one filling the host. Its bar carries the Unfocus control. */
  zoomed?: boolean;
  onZoom?: () => void; onUnzoom?: () => void;
}) {
  const deleteItem = useApp((s) => s.deleteItem);
  const run = useApp((s) => s.run);
  // The palette's "Rename focused item" arms renamingItemId; items are unique in the layout, so at
  // most one PanelBar answers. Local state covers the click-to-rename path.
  const renameArmed = useApp((s) => s.renamingItemId === item.id);
  const requestRename = useApp((s) => s.requestRename);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Two-step destructive confirm (U-H2), same pattern as the sidebar's item menu.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const Meta = paneMeta[item.kind];
  const Actions = paneActions[item.kind];
  const isBrowser = item.kind === "browser";
  const closeMenu = () => { setMenuOpen(false); setConfirmingDelete(false); };
  /** Focus (fill the host) / Unfocus (back to the split). Always inline while zoomed — with every
   *  other pane hidden, the ⋯ menu is not where a user looks for the way back out, and a browser
   *  pane has no ⋯ menu at all (W2.3's no-overlay rule). */
  const focusBtn = zoomed
    ? (onUnzoom ? (
        <button className="icon-btn panel-unfocus" aria-label={`Unfocus ${item.title}`} title="Unfocus (⌘⇧F)"
          onClick={onUnzoom}><Icon name="unfocusPane" size={14} /></button>
      ) : null)
    : (onZoom ? (
        <button className="icon-btn" aria-label={`Focus ${item.title}`} title="Focus — fill the space (⌘⇧F)"
          onClick={onZoom}><Icon name="focusPane" size={14} /></button>
      ) : null);
  return (
    <div className="panel-bar">
      <span className="panel-icon"><Icon name={item.kind} size={14} /></span>
      {(renaming || renameArmed)
        ? <span className="panel-rename"><RenameInput item={item} onDone={() => { setRenaming(false); if (renameArmed) requestRename(null); }} /></span>
        : (
          <button className="panel-title" title="Click to rename" aria-label={`Rename ${item.title}`}
            onClick={() => setRenaming(true)}>{item.title}</button>
        )}
      <span className="panel-meta">{Meta ? <Meta item={item} /> : null}</span>
      <span className="panel-actions">
        {Actions ? <Actions item={item} /> : null}
        {isBrowser ? (
          // W2.3 (no-overlay): a browser pane's header may never spawn a dropdown — the native view
          // paints over anything that opens below the bar. Everything the ⋯ menu carried is inline:
          // rename is the title itself (click to rename), split and delete are toolbar buttons, and
          // delete keeps its two-step confirm (U-H2) in place instead of inside a menu.
          <>
            {focusBtn}
            <button className="icon-btn" aria-label={`Split ${item.title} right`} title="Split right (⌘\)"
              onClick={() => onSplit("row")}><Icon name="splitRight" size={14} /></button>
            <button className="icon-btn" aria-label={`Split ${item.title} down`} title="Split down (⌘⇧\)"
              onClick={() => onSplit("col")}><Icon name="splitDown" size={14} /></button>
            {confirmingDelete ? (
              <button className="icon-btn danger panel-confirm" aria-label={`Really delete ${item.title}?`}
                title="Click again to delete" onBlur={() => setConfirmingDelete(false)}
                onClick={() => run(() => deleteItem(item.id))}>Really delete?</button>
            ) : (
              <button className="icon-btn danger" aria-label={`Delete ${item.title}`} title="Delete"
                onClick={() => setConfirmingDelete(true)}><Icon name="trash" size={14} /></button>
            )}
          </>
        ) : (
          <>
          {zoomed && focusBtn}
          <button ref={menuBtn} className="icon-btn" aria-label={`Pane menu for ${item.title}`} aria-haspopup="menu"
            aria-expanded={menuOpen} title="Pane menu" onClick={() => { setConfirmingDelete(false); setMenuOpen((v) => !v); }}>
            <Icon name="more" size={14} />
          </button>
          </>
        )}
        <button className="icon-btn" aria-label={`Close ${item.title}`} title="Close (⌘W)" onClick={onClose}><Icon name="close" size={14} /></button>
      </span>
      {!isBrowser && menuOpen && (
        <Menu anchorRef={menuBtn} align="right" label={`Actions for ${item.title}`} onClose={closeMenu} items={[
          { label: "Rename", onSelect: () => setRenaming(true) },
          { kind: "separator" },
          { label: "Split right", kbd: "⌘\\", onSelect: () => onSplit("row") },
          { label: "Split down", kbd: "⌘⇧\\", onSelect: () => onSplit("col") },
          ...(zoomed
            ? (onUnzoom ? [{ label: "Unfocus pane", kbd: "⌘⇧F", onSelect: onUnzoom }] : [])
            : (onZoom ? [{ label: "Focus pane", kbd: "⌘⇧F", onSelect: onZoom }] : [])),
          { label: "Close", kbd: "⌘W", onSelect: onClose },
          { kind: "separator" },
          confirmingDelete
            ? { label: <strong>Really delete?</strong>, danger: true, onSelect: () => run(() => deleteItem(item.id)) }
            : { label: "Delete", danger: true, keepOpen: true, onSelect: () => setConfirmingDelete(true) },
        ]} />
      )}
    </div>
  );
}

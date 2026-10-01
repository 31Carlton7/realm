import { Icon } from "@realm/ui";
import { useState, type DragEvent } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../state/store";
import { REALM_ITEM_TYPE } from "./drag-types";
import { DELETES_ON_CLOSE, PAGE_KINDS } from "./pane-close";

/**
 * A side pane's tab strip, in its bar where a single pane's title goes.
 *
 * In the bar rather than a row above it: the pane under it brings chrome of its own (a browser's
 * address bar, a session's composer), and a strip stacked over a bar over a toolbar is three rows of
 * chrome before the page. The strip is the title — each tab names its item, the one showing is lit.
 *
 * Each tab is draggable like a sidebar row. Dropped on another tab it moves there; dropped on a pane
 * edge it leaves the strip as a pane of its own (`openItemAt`), which is the one way something an
 * agent opened becomes part of the user's own arrangement.
 *
 * The close on a tab is the pane bar's own last control, with its own rule: a session or a diff
 * leaves the layout and stays in the space, while a browser, terminal or documents pane is deleted —
 * two-step where there is something under it, as the bar's is.
 */
export function PaneTabs({ leafId, tabs, activeId, onRename }: {
  leafId: string;
  tabs: Item[];
  activeId: string;
  /** Double-click on the tab showing: rename it, as a click on a single pane's title does. */
  onRename: () => void;
}) {
  const openItem = useApp((s) => s.openItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const deleteItem = useApp((s) => s.deleteItem);
  const moveTab = useApp((s) => s.moveTab);
  const confirmDelete = useApp((s) => s.confirmDelete);
  const run = useApp((s) => s.run);
  const [arming, setArming] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const ids = tabs.map((t) => t.id);
  const carriesItem = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(REALM_ITEM_TYPE);
  return (
    <div className="pane-tabs" role="tablist" aria-label="Tabs">
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        const deletes = DELETES_ON_CLOSE.has(t.kind);
        const close = () => {
          if (!deletes) { run(() => closeFromLayout(t.id)); return; }
          if (confirmDelete && !PAGE_KINDS.has(t.kind) && arming !== t.id) { setArming(t.id); return; }
          setArming(null);
          run(() => deleteItem(t.id));
        };
        return (
          <div key={t.id} className="pane-tab" data-active={active || undefined} data-over={over === t.id || undefined}
            onDragOver={(e) => { if (carriesItem(e)) { e.preventDefault(); e.stopPropagation(); setOver(t.id); } }}
            onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
            onDrop={(e) => {
              if (!carriesItem(e)) return;
              e.preventDefault();
              e.stopPropagation();
              setOver(null);
              const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
              if (!id || id === t.id) return;
              // A tab of this strip moves; anything else — a sidebar row, a tab of another pane —
              // joins it, and lands where it was dropped.
              if (ids.includes(id)) run(() => moveTab(leafId, id, i));
              else run(async () => { await openItem(id, leafId); await moveTab(leafId, id, i); });
            }}>
            <button type="button" role="tab" className="pane-tab-label" aria-selected={active} title={t.title}
              draggable onDragStart={(e) => { e.dataTransfer.setData(REALM_ITEM_TYPE, t.id); e.dataTransfer.effectAllowed = "move"; }}
              onClick={() => { if (!active) run(() => openItem(t.id, leafId)); }}
              onDoubleClick={active ? onRename : undefined}>
              <Icon name={t.kind} size={14} />
              <span className="pane-tab-title">{t.title}</span>
            </button>
            {arming === t.id ? (
              <button type="button" className="icon-btn danger pane-tab-confirm" aria-label={`Really delete ${t.title}?`}
                title="Click again to delete" autoFocus onBlur={() => setArming(null)} onClick={close}>Delete?</button>
            ) : (
              <button type="button" className="icon-btn pane-tab-close" aria-label={deletes ? `Delete ${t.title}` : `Close ${t.title}`}
                title={deletes ? "Delete — removes it from the space, not just this tab" : "Close tab (keep in space)"}
                onClick={close}><Icon name="close" size={12} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}

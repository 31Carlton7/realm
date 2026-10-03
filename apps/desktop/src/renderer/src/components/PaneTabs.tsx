import { Icon } from "@realm/ui";
import { useRef, useState, type DragEvent } from "react";
import { chordsForCommand, displayKeyChord, type Item } from "@realm/contracts";
import { useApp } from "../state/store";
import { REALM_ITEM_TYPE } from "./drag-types";
import { Menu } from "./Menu";
import { DELETES_ON_CLOSE, PAGE_KINDS } from "./pane-close";
import { ItemIcon } from "./PageIcon";

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
 *
 * The "+" after the last tab is where a person adds one: a blank tab here, or the same tab with this
 * pane filling the host ("full view", which is pane focus). A menu rather than two buttons, because
 * the strip is the bar's data of unbounded length and a second control would come out of its width.
 * The menu is the shared one, so it goes round a browser view rather than under it (no-overlay.ts).
 *
 * A browser's tab wears its page's own icon once the page has offered one, as a browser's tabs do, and
 * the kind's glyph until then.
 *
 * A peek's tab says what it is twice over, in the shape and the words: an eye where the kind's glyph
 * goes and its title in italic, because it is the one tab here that will not be here tomorrow — and
 * it does not drag, since an edge would make it part of an arrangement it was never written into.
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
  const newTab = useApp((s) => s.newTab);
  const keybindings = useApp((s) => s.keybindings);
  const peekId = useApp((s) => s.peek?.item.id ?? null);
  const run = useApp((s) => s.run);
  const [arming, setArming] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const ids = tabs.map((t) => t.id);
  const carriesItem = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(REALM_ITEM_TYPE);
  /* From the keymap the handler reads, as the palette's hints are: a user who rebinds the chord sees
     their own, and an unbound command shows none rather than one Realm has no basis for. */
  const chord = (command: string) => {
    const c = chordsForCommand(keybindings, command)[0];
    return c ? displayKeyChord(c) : undefined;
  };
  return (
    <div className="pane-strip">
      <div className="pane-tabs" role="tablist" aria-label="Tabs">
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const peek = t.id === peekId;
          const deletes = DELETES_ON_CLOSE.has(t.kind);
          const close = () => {
            if (!deletes) { run(() => closeFromLayout(t.id)); return; }
            if (confirmDelete && !PAGE_KINDS.has(t.kind) && arming !== t.id) { setArming(t.id); return; }
            setArming(null);
            run(() => deleteItem(t.id));
          };
          return (
            <div key={t.id} className="pane-tab" data-active={active || undefined} data-over={over === t.id || undefined} data-peek={peek || undefined}
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
              <button type="button" role="tab" className="pane-tab-label" aria-selected={active}
                aria-label={peek ? `Peek: ${t.title}` : undefined}
                title={peek ? `${t.title} — a peek, not kept in this space's layout` : t.title}
                draggable={!peek} onDragStart={peek ? undefined : (e) => { e.dataTransfer.setData(REALM_ITEM_TYPE, t.id); e.dataTransfer.effectAllowed = "move"; }}
                onClick={() => { if (!active) run(() => openItem(t.id, leafId)); }}
                onDoubleClick={active && !peek ? onRename : undefined}>
                {peek ? <Icon name="peek" size={14} /> : <ItemIcon item={t} size={14} />}
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
      <button ref={addBtn} type="button" className="icon-btn pane-tabs-add" aria-label="New tab" title="New tab"
        aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
        <Icon name="add" size={14} />
      </button>
      {adding && (
        <Menu anchorRef={addBtn} label="New tab" onClose={() => setAdding(false)} items={[
          { label: "New tab", icon: <Icon name="add" size={14} />, kbd: chord("pane.newTab"), onSelect: () => run(() => newTab(leafId)) },
          /* The glyph pane focus wears in the bar and in every pane's menu, because this is that action. */
          { label: "New tab in full view", icon: <Icon name="focusPane" size={14} />, kbd: chord("pane.newTabFullView"),
            onSelect: () => run(() => newTab(leafId, { full: true })) },
        ]} />
      )}
    </div>
  );
}

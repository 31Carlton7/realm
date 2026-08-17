import { useCallback, useState, type MouseEvent } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";

export type ItemMenuState = { item: Item; x: number; y: number } | null;

/** Right-click menu shared by pinned tiles and list rows: Pin/Unpin, Rename (inline, via `onRename`), Close. */
export function useItemContextMenu(onRename: (item: Item) => void) {
  const [menu, setMenu] = useState<ItemMenuState>(null);
  const updateItem = useApp((s) => s.updateItem);
  const closeItem = useApp((s) => s.closeItem);
  const run = useApp((s) => s.run);
  const onContextMenu = useCallback((item: Item) => (e: MouseEvent) => { e.preventDefault(); setMenu({ item, x: e.clientX, y: e.clientY }); }, []);
  const close = useCallback(() => setMenu(null), []);
  const element = menu ? (
    <Menu at={{ x: menu.x, y: menu.y }} label={`Actions for ${menu.item.title}`} onClose={close} items={[
      { label: menu.item.pinned ? "Unpin" : "Pin", onSelect: () => run(() => updateItem({ id: menu.item.id, pinned: !menu.item.pinned })) },
      { label: "Rename", onSelect: () => onRename(menu.item) },
      { kind: "separator" },
      { label: "Close", danger: true, onSelect: () => run(() => closeItem(menu.item.id)) },
    ]} />
  ) : null;
  return { onContextMenu, element };
}

/** Inline rename input; commits on Enter/blur, cancels on Escape. */
export function RenameInput({ item, onDone }: { item: Item; onDone: () => void }) {
  const updateItem = useApp((s) => s.updateItem);
  const run = useApp((s) => s.run);
  const [value, setValue] = useState(item.title);
  const commit = () => { const t = value.trim(); if (t && t !== item.title) run(() => updateItem({ id: item.id, title: t })); onDone(); };
  return (
    <input className="rename" aria-label={`Rename ${item.title}`} autoFocus value={value}
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onDone(); }} />
  );
}

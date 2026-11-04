import { Icon } from "@realm/ui";
import { useRef, useState, type MouseEvent } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";
import { useSpaceMenu } from "./space-menu";
import { useSpaceTint } from "./use-sidebar-model";

/**
 * The column's title: the space it shows, by name (direction A, the owner 11-03).
 *
 * A plain title, not a switcher — the rail's tiles change the space and the rail's avatar the
 * profile, so a chevron here would be a third way to do one of those. A quiet "···" comes up under
 * the pointer (and stays for the keyboard) with what can be done about the space, the same list a
 * right-click on its tile opens. Rename turns the name into a field in place.
 */
export function SpaceTitle() {
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const renaming = useApp((s) => !!space && s.renamingSpaceId === space.id);
  const renameSpaceInColumn = useApp((s) => s.renameSpaceInColumn);
  const tint = useSpaceTint(space?.color);
  const items = useSpaceMenu(space);
  const [menu, setMenu] = useState<{ at: { x: number; y: number } | null } | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  if (!space) return null;
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ at: e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY } });
  };
  return (
    <div className="sb-space-title" onContextMenu={onContextMenu}>
      <span className="sb-space-icon" style={tint ? { color: tint } : undefined}><SpaceIcon icon={space.icon} size={16} /></span>
      {renaming
        ? <SpaceNameInput id={space.id} name={space.name} onDone={() => renameSpaceInColumn(null)} />
        : <h2 className="sb-space-name" title={space.name}>{space.name}</h2>}
      <button ref={more} type="button" className="item-act sb-space-more" aria-label={`More for ${space.name}`} aria-haspopup="menu"
        aria-expanded={menu !== null} title="Space settings and more" onClick={() => setMenu((o) => (o ? null : { at: null }))}>
        <Icon name="more" size={14} />
      </button>
      {menu && <Menu {...(menu.at ? { at: menu.at } : { anchorRef: more, align: "right" as const })} label={space.name}
        onClose={() => setMenu(null)} items={items} />}
    </div>
  );
}

/** The title as a field: Enter or leaving it saves, Escape puts the name back. */
function SpaceNameInput({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const updateSpace = useApp((s) => s.updateSpace);
  const run = useApp((s) => s.run);
  const [value, setValue] = useState(name);
  const commit = () => {
    const next = value.trim();
    if (next && next !== name) run(() => updateSpace({ id, name: next }));
    onDone();
  };
  return (
    <input className="rename sb-space-name" aria-label={`Rename ${name}`} autoFocus value={value} maxLength={80}
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { e.preventDefault(); onDone(); } }} />
  );
}

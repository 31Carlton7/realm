import { Icon } from "@realm/ui";
import { useRef, useState, type MouseEvent } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";
import { useSpaceMenu } from "./space-menu";
import { useOpenSpacePage, useSpaceTint } from "./use-sidebar-model";

/**
 * The column's title: the space it shows, by name (direction A, the owner 11-03).
 *
 * A plain title, not a switcher — the rail's tiles change the space and the rail's avatar the
 * profile, so a chevron here would be a third way to do one of those. A "···" in the quiet ink, always
 * drawn, opens what can be done about the space, the same list a right-click on its tile opens. Rename
 * turns the name into a field in place.
 *
 * The name and its icon are one button that opens the space's page, the page a session's breadcrumb
 * opens (the owner, 11-18: "you click it and then you see the main page for managing the space"). It
 * stays the column's heading, by the space's name, so the button is the heading's content rather than
 * a heading of its own.
 */
export function SpaceTitle() {
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const renaming = useApp((s) => !!space && s.renamingSpaceId === space.id);
  const renameSpaceInColumn = useApp((s) => s.renameSpaceInColumn);
  const tint = useSpaceTint(space?.color);
  const items = useSpaceMenu(space);
  const openSpacePage = useOpenSpacePage();
  const [menu, setMenu] = useState<{ at: { x: number; y: number } | null } | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  if (!space) return null;
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ at: e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY } });
  };
  const icon = <span className="sb-space-icon" style={tint ? { color: tint } : undefined} aria-hidden="true"><SpaceIcon icon={space.icon} size={16} /></span>;
  return (
    <div className="sb-space-title" onContextMenu={onContextMenu}>
      {renaming ? (
        <span className="sb-space-open">
          {icon}
          <SpaceNameInput id={space.id} name={space.name} onDone={() => renameSpaceInColumn(null)} />
        </span>
      ) : (
        <h2 className="sb-space-head" aria-label={space.name}>
          <button type="button" className="sb-space-open" aria-label={`Open ${space.name}`} title={`Open the page for ${space.name}`}
            onClick={() => openSpacePage(space.id)}>
            {icon}
            <span className="sb-space-name">{space.name}</span>
          </button>
        </h2>
      )}
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

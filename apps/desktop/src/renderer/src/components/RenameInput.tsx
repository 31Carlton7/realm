import { useState } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../state/store";

/** Inline rename input (sidebar rows, pinned tiles, pane headers); commits on Enter/blur, cancels on
 *  Escape. Store-connected: commits via updateItem. */
export function RenameInput({ item, onDone }: { item: Item; onDone: () => void }) {
  const updateItem = useApp((s) => s.updateItem);
  const run = useApp((s) => s.run);
  const [value, setValue] = useState(item.title);
  const commit = () => { const t = value.trim(); if (t && t !== item.title) run(() => updateItem({ id: item.id, title: t })); onDone(); };
  return (
    <input className="rename" aria-label={`Rename ${item.title}`} autoFocus value={value}
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      // preventDefault marks the event consumed so the global Escape binding (interrupt) never sees it.
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { e.preventDefault(); onDone(); } }} />
  );
}

/** The same inline rename for a PANE GROUP. Separate from `RenameInput` because a group is not an
 *  Item — it has no server row of its own, and its name is persisted as part of the space's group set
 *  (`renamePaneGroup`), not through `items.update`. */
export function GroupRenameInput({ group, onDone }: { group: { id: string; name: string }; onDone: () => void }) {
  const renamePaneGroup = useApp((s) => s.renamePaneGroup);
  const run = useApp((s) => s.run);
  const [value, setValue] = useState(group.name);
  const commit = () => { const t = value.trim(); if (t && t !== group.name) run(() => renamePaneGroup(group.id, t)); onDone(); };
  return (
    <input className="rename" aria-label={`Rename ${group.name}`} autoFocus value={value}
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { e.preventDefault(); onDone(); } }} />
  );
}

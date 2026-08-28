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

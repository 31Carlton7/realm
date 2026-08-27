import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useApp } from "../../state/store";

/** Bottom bar: settings (left), one icon button per space (center, drag to reorder), + new space (right). */
export function SpaceStrip() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const selectSpace = useApp((s) => s.selectSpace);
  const reorderSpaces = useApp((s) => s.reorderSpaces);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // With 10+ spaces the strip scrolls; keep the active space reachable/visible on every activation
  // (safe-centered flex can clip either end, and the scrollbar is hidden).
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { activeRef.current?.scrollIntoView?.({ inline: "nearest", block: "nearest" }); }, [activeSpaceId]);

  const drop = (targetId: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    if (!from || from === targetId) return;
    const ids = spaces.map((s) => s.id);
    const fromIdx = ids.indexOf(from), toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    // Drop takes the target's slot: before it when dragging left, after it when dragging right.
    ids.splice(fromIdx, 1); ids.splice(toIdx, 0, from);
    run(() => reorderSpaces(ids));
  };
  const onDragOver = (id: string) => (e: DragEvent) => { if (dragId) { e.preventDefault(); if (overId !== id) setOverId(id); } };

  return (
    <div className="space-strip">
      <button className="icon-btn strip-side" aria-label="Settings" title="Settings" onClick={() => { /* Settings arrives with a later plan */ }}><Icon name="settings" size={16} /></button>
      <div className="strip-spaces" aria-label="Spaces">
        {spaces.map((sp) => (
          <button key={sp.id} ref={sp.id === activeSpaceId ? activeRef : null} className="strip-space" aria-pressed={sp.id === activeSpaceId} aria-label={`Switch to space ${sp.name}`} title={sp.name}
            data-active={sp.id === activeSpaceId || undefined} data-drag-over={overId === sp.id || undefined}
            draggable onDragStart={(e) => { setDragId(sp.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", sp.id); }}
            onDragOver={onDragOver(sp.id)} onDragLeave={() => { if (overId === sp.id) setOverId(null); }}
            onDrop={(e) => { e.preventDefault(); drop(sp.id); }} onDragEnd={() => { setDragId(null); setOverId(null); }}
            style={{ ["--space-color" as string]: sp.color }}
            onClick={() => run(() => selectSpace(sp.id))}>
            <Icon name={sp.icon} size={16} />
            <span className="strip-dot" aria-hidden />
          </button>
        ))}
      </div>
      <button className="icon-btn strip-side" aria-label="New space" title="New space" onClick={() => openSheet({ kind: "new-space" })}><Icon name="add" size={16} /></button>
    </div>
  );
}

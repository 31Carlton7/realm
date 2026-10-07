import { useState, type DragEvent } from "react";
import { REALM_ITEM_TYPE } from "./drag-types";

/**
 * A target that accepts one of Realm's OWN items, dragged out of the sidebar.
 *
 * `useFileDrop`'s twin, and separate from it on purpose: that hook claims only drags carrying
 * `Files`, and its own note says Realm's item drags "have to pass through untouched to the pane's own
 * drop handling" — a session dragged between groups must keep working. So this claims the other
 * vocabulary, and only over the element that wants it.
 *
 * The claim is what keeps the two meanings apart. Dropping a session on a PANE moves it between
 * groups; dropping it on the PROMPTER inside that pane points the draft at it. Both are live at once
 * and the inner target wins, which is the same rule files already follow — and it has to claim on all
 * four events, or the outer target sees a leave with no matching enter and stays lit for the rest of
 * the drag.
 */
export function useItemDrop(onItem: (itemId: string) => void, claim = true): {
  dropping: boolean; handlers: { onDragEnter: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
} {
  const [depth, setDepth] = useState(0);
  const mine = (e: DragEvent): boolean => {
    if (!(e.dataTransfer?.types?.includes(REALM_ITEM_TYPE) ?? false)) return false;
    if (claim) e.stopPropagation();
    return true;
  };
  return {
    dropping: depth > 0,
    handlers: {
      onDragEnter: (e) => { if (mine(e)) { e.preventDefault(); setDepth((d) => d + 1); } },
      // `link`, not `copy`: nothing is duplicated here — the draft gains a pointer to something that
      // goes on existing somewhere else, which is exactly what the cursor should say.
      onDragOver: (e) => { if (mine(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "link"; } },
      onDragLeave: (e) => { if (mine(e)) setDepth((d) => Math.max(0, d - 1)); },
      onDrop: (e) => {
        if (!mine(e)) return;
        e.preventDefault();
        setDepth(0);
        const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
        if (id) onItem(id);
      },
    },
  };
}

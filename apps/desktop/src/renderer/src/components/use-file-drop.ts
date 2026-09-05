import { useState, type DragEvent } from "react";
import { carriesFiles } from "./drag-types";

/** The four handlers a file-drop target needs, spread straight onto the element. */
export type FileDropHandlers = {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
};

/**
 * A target that accepts files dragged in from outside the app.
 *
 * `dropping` is derived from a COUNT rather than a boolean: dragging across a child fires
 * leave-then-enter, and a boolean flickers the target off at every internal boundary.
 *
 * `claim` is what keeps two nested targets from both taking one drop. The session pane and the
 * prompter inside it are both targets; the prompter claims, so a drag over it never reaches the pane
 * and exactly one of the two affordances is ever lit. It has to claim on all FOUR events, not just
 * the drop — an outer target that saw the leave but not the matching enter would count itself
 * negative and stay lit for the rest of the drag.
 *
 * Only a drag carrying files is ever claimed. Realm drags its own sessions and panes between groups,
 * and those have to pass through untouched to the pane's own drop handling.
 */
export function useFileDrop(onFiles: (files: File[]) => void, claim = false): { dropping: boolean; handlers: FileDropHandlers } {
  const [depth, setDepth] = useState(0);
  const mine = (e: DragEvent): boolean => {
    if (!carriesFiles(e)) return false;
    if (claim) e.stopPropagation();
    return true;
  };
  return {
    dropping: depth > 0,
    handlers: {
      onDragEnter: (e) => { if (mine(e)) { e.preventDefault(); setDepth((d) => d + 1); } },
      onDragOver: (e) => { if (mine(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
      onDragLeave: (e) => { if (mine(e)) setDepth((d) => Math.max(0, d - 1)); },
      onDrop: (e) => {
        if (!mine(e)) return;
        e.preventDefault();
        setDepth(0);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

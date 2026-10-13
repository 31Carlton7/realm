import { useSyncExternalStore } from "react";
import type { Item } from "@realm/contracts";
import type { MenuItem } from "../../components/Menu";
import { canShare, shareFile } from "../../components/file-actions";

/** Whether this Mac's bridge can hand a PDF to Preview (main/file-actions.ts). Here rather than in
 *  PdfView so the pane bar can ask without loading pdf.js. */
export const canOpenInPreview = (): boolean => typeof window.realm?.files?.openInPreview === "function";
export const openInPreview = (path: string): void => { void window.realm?.files?.openInPreview?.(path); };

/**
 * The file a documents pane has on screen, for the pane's ⋯ menu — which the pane's BAR draws, outside
 * the pane, from `usePaneMenuItems` (registry.tsx). The pane publishes it here as its active tab
 * changes; the bar's hook reads it. Keyed by the pane's item, so two documents panes never answer
 * for each other.
 */
type Shown = { path: string; kind: string };
const shown = new Map<string, Shown>();
const listeners = new Set<() => void>();

export function publishShownFile(itemId: string, file: Shown | null): void {
  const was = shown.get(itemId);
  if (file === null ? !was : was?.path === file.path && was.kind === file.kind) return;
  if (file) shown.set(itemId, file); else shown.delete(itemId);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * What a Mac does with the PDF a pane is showing, now that Realm draws it instead of Chromium's viewer
 * (whose toolbar had Print and Download): hand it to Preview, which prints, fills forms and signs, or
 * share it. Each only where the desktop bridge has it.
 */
export function useDocumentsMenuItems(item: Item): MenuItem[] {
  const file = useSyncExternalStore(subscribe, () => (item.kind === "documents" ? shown.get(item.id) ?? null : null));
  if (!file || file.kind !== "pdf") return [];
  return [
    ...(canOpenInPreview() ? [{ label: "Open in Preview", title: "Print, fill in or sign it there", onSelect: () => openInPreview(file.path) }] : []),
    // Under the document's name, the control nearest to what is being shared.
    ...(canShare() ? [{ label: "Share…", onSelect: () => shareFile(file.path, document.querySelector<HTMLElement>(`[data-item="${CSS.escape(item.id)}"] .documents-name`)
      ?? document.querySelector<HTMLElement>(".documents-name")) }] : []),
  ];
}

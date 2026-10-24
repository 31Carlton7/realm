import { useSyncExternalStore } from "react";
import type { Item } from "@realm/contracts";
import type { MenuItem } from "../../components/Menu";
import { canShare, shareFile } from "../../components/file-actions";
import { capabilities } from "../../platform";

/** Whether this Mac's bridge can hand a PDF to Preview (main/file-actions.ts). Here rather than in
 *  PdfView so the pane bar can ask without loading pdf.js. */
export const canOpenInPreview = (): boolean => typeof window.realm?.files?.openInPreview === "function";
export const openInPreview = (path: string): void => { void window.realm?.files?.openInPreview?.(path); };

/** Whether the bridge can select a path in the Finder. Main resolves it through `existingPath`, so a
 *  `~/…` path reveals as the folder it names rather than as nothing. */
export const canReveal = (): boolean => typeof window.realm?.files?.reveal === "function";
export const revealPath = (path: string): void => { void window.realm?.files?.reveal?.(path); };
/** "Show in Finder" on a Mac, "Show in File Explorer" on Windows, "Show in Files" on Linux. */
export const showInLabel = (): string => `Show in ${capabilities().fileManager}`;

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
 * What a Mac does with the file a pane is showing. For a PDF, now that Realm draws it instead of
 * Chromium's viewer (whose toolbar had Print and Download): hand it to Preview, which prints, fills
 * forms and signs, or share it. For any file: the Finder, worded as the file's own menu words it on the
 * pane's home. Each only where the desktop bridge has it.
 */
export function useDocumentsMenuItems(item: Item): MenuItem[] {
  const file = useSyncExternalStore(subscribe, () => (item.kind === "documents" ? shown.get(item.id) ?? null : null));
  if (!file) return [];
  const reveal: MenuItem[] = canReveal() ? [{ label: `Reveal in ${capabilities().fileManager}`, onSelect: () => revealPath(file.path) }] : [];
  if (file.kind !== "pdf") return reveal;
  return [
    ...(canOpenInPreview() ? [{ label: "Open in Preview", title: "Print, fill in or sign it there", onSelect: () => openInPreview(file.path) }] : []),
    // Under the document's name, the control nearest to what is being shared.
    ...(canShare() ? [{ label: "Share…", onSelect: () => shareFile(file.path, document.querySelector<HTMLElement>(`[data-item="${CSS.escape(item.id)}"] .documents-name`)
      ?? document.querySelector<HTMLElement>(".documents-name")) }] : []),
    ...reveal,
  ];
}

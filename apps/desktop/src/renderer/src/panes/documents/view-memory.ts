/**
 * A documents pane's own view — Rich or Source, and whether its Files home was up — kept across the
 * unmount a session or space switch causes (the pane is a tab of a session's side panel, and goes with
 * it), as a reader's scroll is (scroll-memory.ts): per workspace, for the run. Coming back to a
 * document in Source and finding it in Rich is a place lost as surely as an offset.
 */
export type DocumentsView = { mode: "rich" | "source"; home: boolean };

const views = new Map<string, DocumentsView>();

export function rememberDocumentsView(documentsId: string, view: DocumentsView): void {
  views.set(documentsId, view);
}

export function recallDocumentsView(documentsId: string): DocumentsView | null {
  return views.get(documentsId) ?? null;
}

/** Test seam, as `forgetAllScroll` is. */
export function forgetDocumentViews(): void {
  views.clear();
}

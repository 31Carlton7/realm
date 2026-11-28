/**
 * The memory documents on screen (MemoryDoc.tsx) holding typing the server does not have yet, by
 * editor. Apart from the editor so the unload guard reads it without loading Settings.
 */
const edited = new Set<string>();

export function holdMemoryEdit(editor: string): () => void {
  edited.add(editor);
  return () => { edited.delete(editor); };
}

/** Whether any memory document holds typing not yet saved: a window unloaded now would lose it. */
export const memoryDocEdited = (): boolean => edited.size > 0;

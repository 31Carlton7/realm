import { createContext, useContext, useMemo } from "react";
import { useAppStoreMaybe } from "../../state/store";
import type { OpenViewerInput, ViewerFile } from "../../state/viewer";

/**
 * The session a surface belongs to, for the media it shows: a session pane's transcript and its
 * prompter, the quick chat. Whatever is opened from inside one is asked about in that session.
 */
export const MediaSessionContext = createContext<string | null>(null);

/** Inside the viewer itself: a file opened from its own exchange — the picture the answer made — is
 *  shown in place, so the exchange and the way back to the original stay. */
export const ViewerShowContext = createContext<((file: ViewerFile) => void) | null>(null);

/**
 * How a surface opens files in the media viewer. Null outside the app's store: the suite renders a
 * transcript bare, and a frame there is a picture with nothing to open into, which is what it draws.
 */
export function useOpenViewer(): ((input: OpenViewerInput) => void) | null {
  const store = useAppStoreMaybe();
  const sessionId = useContext(MediaSessionContext);
  const show = useContext(ViewerShowContext);
  return useMemo(() => {
    if (show) return (input: OpenViewerInput) => { const f = input.files[input.index ?? 0]; if (f) show(f); };
    return store ? (input: OpenViewerInput) => store.getState().openViewer({ sessionId, ...input }) : null;
  }, [store, sessionId, show]);
}

import { createContext } from "react";

/**
 * The quiet cue that says whose a tab of the side panel is, while several sessions' tabs share it:
 * the pointer on a tab marks the pane of the session it belongs to (`data-owner-hover` on that pane).
 *
 * Imperative rather than state, on purpose: a hover that re-rendered the pane host would re-render
 * every pane in it twice per pass of the pointer along the strip, to change one attribute.
 */
export const OwnerCueContext = createContext<(owner: string | null) => void>(() => {});

import { useRef } from "react";
import { useFittedLens } from "./fitted-lens";

/**
 * The glass under the prompter's content: one empty layer that bends and frosts what is behind the
 * card (styles.css, `.composer-glass`). Over a picture the card has no face, so what it bends is the
 * picture's canvas; on a plain pane the card's own tinted face is in that backdrop, so the filter
 * never works on the window's bare transparency. The editor, the caret and the bars stay where
 * they were, as ordinary children of the card above it.
 *
 * Its lens is fitted to the card as the pickers' are (fitted-lens.ts), and refitted as the card grows
 * from one line to many, so the bezel stays the same depth at every height.
 */
export function PrompterGlass() {
  const ref = useRef<HTMLSpanElement>(null);
  useFittedLens(ref, true);
  return <span ref={ref} className="composer-glass" aria-hidden="true" />;
}

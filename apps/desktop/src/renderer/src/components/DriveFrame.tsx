import { useEffect, useState } from "react";
import { AGENT_FRAME } from "@realm/contracts";

/**
 * "An agent is controlling this" — drawn on one of Realm's OWN surfaces.
 *
 * ## Why this is a second implementation of something that already exists
 *
 * The same frame is already drawn around a browser pane and a simulator, and it is drawn there by
 * injecting DOM into the page over CDP, because a `WebContentsView` composites above all DOM
 * unconditionally and nothing the renderer paints beside one can reach it. `agent-cursor.ts` wrote
 * this arrangement down before either half existed: "two surfaces, two transports, one appearance —
 * so the appearance is a number table both read, and `styles.test.ts` asserts the parity. Anything
 * more shared than this table would be a false abstraction over surfaces with different physics."
 *
 * This is that second surface. A terminal pane is ordinary DOM in Realm's own window, so the mark is
 * an ordinary overlay and no injection is involved or possible.
 *
 * ## What is shared and what is not
 *
 * Shared is everything that carries the MEANING: the accent, the ring's weight, the glow's spread,
 * the pulse rate, and how long the mark outlives the last act. Those are asserted equal against
 * `AGENT_FRAME`, the table both halves import, and `styles.test.ts` holds the stylesheet to it.
 *
 * Not shared is the geometry, and deliberately. The injected frame is flush to the viewport because
 * inside a page the pane's edge is somewhere else entirely; here the pane's edge is right there, and
 * `styles.css` already writes down what happens to a flush glow beside another pane — "in a four-way
 * split a flush ring would run straight into its neighbour's and the two would look like one
 * target". So the pane-scoped frame is inset and takes the pane's own corner, exactly as the file
 * drop highlight it sits beside does. Copying a number across a boundary that changes what the
 * number means is not parity.
 *
 * ## The linger, and why the component owns it
 *
 * The frame outlives the last act by `AGENT_FRAME.lingerMs` and then fades itself. Two reasons, both
 * borrowed from the injected half: agents act in bursts, so tearing the frame down between writes
 * would flash the pane rather than inform it; and a timer the VIEW owns means a dropped
 * `driving: false` — a crashed server, a socket that died mid-act — cannot leave a pane wearing a
 * frame forever. Every arriving `active` resets it, so a run of acts is one continuous showing.
 */
export function DriveFrame({ active, subject, scope = "pane" }: {
  active: boolean;
  /** What is being controlled, in the sentence's own words: "this terminal", "Realm". */
  subject: string;
  /** `window` is flush to the window and has no neighbour to be confused with; `pane` insets. */
  scope?: "pane" | "window";
}) {
  const [shown, setShown] = useState(active);

  useEffect(() => {
    if (active) { setShown(true); return; }
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), AGENT_FRAME.lingerMs);
    return () => clearTimeout(timer);
  }, [active, shown]);

  if (!shown) return null;
  return (
    // aria-hidden, and no role: the frame is a picture of a fact the sidebar row's status dot already
    // states in words. A screen reader hearing it twice learns nothing the second time.
    <div className="drive-frame" data-scope={scope} aria-hidden>
      {/* The glow is an ELEMENT rather than a `::before`, for the same reason the injected frame
          gives it its own node: the app-wide reduced-motion kill is `* { animation: none }`, and
          `*` does not match a pseudo-element. A glow on `::before` would keep pulsing for a reader
          who turned motion off — the failure `styles.css` already writes down about the eggs wash,
          reappearing here. */}
      <span className="drive-frame-glow" />
      <span className="drive-frame-label">An agent is controlling {subject}</span>
    </div>
  );
}

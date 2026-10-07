/**
 * Where the selection bar goes, as arithmetic over four rectangles.
 *
 * Split out from the component because this is the whole feature and jsdom cannot test a line of it
 * in place: a `Range` there reports every rect as zero, so a suite driving a real selection would be
 * asserting against a bar placed at the origin and would pass no matter what this returned. Pure
 * numbers in, pure numbers out, tested exhaustively here — and the real geometry is measured in the
 * Electron window by `selection-bar-live.mjs`, which is the only place it can be.
 *
 * Everything is in the coordinate space of the wrapper the bar is absolutely positioned in, which is
 * `.transcript-wrap` — outside the scroller on purpose. The transcript wears an edge dissolve, and a
 * mask applies to everything its element paints, so a bar mounted inside would be faded by it. The
 * hazard is the BOTTOM end: that band is 68px against the top's 40px, and a passage selected against
 * it puts a 32px bar almost entirely inside. Measured — `selection-bar-live.mjs` re-parents the bar
 * into the scroller at the same coordinates and the brightest pixel of its label drops by a fifth.
 */

/** The gap between the selection and the bar's near edge. */
export const BAR_GAP = 8;
/** How close the bar may come to the wrapper's own edges before it is pushed back in. */
export const BAR_MARGIN = 8;

export type Box = { left: number; top: number; width: number; height: number };
export type Placement = { left: number; top: number; below: boolean };

/**
 * The bar's position for a selection, in wrapper coordinates — or null when there is nothing to
 * point at.
 *
 * Centred on the selection and preferring ABOVE it, which is the side the pointer is not on: a bar
 * under the selection lands where the cursor already is at the end of a downward drag, so it opens
 * under the user's own hand and the first thing they see is their pointer covering it.
 *
 * It flips below only when above genuinely does not fit — a passage selected in the first line of the
 * pane — and it is clamped horizontally rather than allowed to hang off the edge, because a selection
 * near the right rail would otherwise put half the bar outside the pane.
 *
 * **Null when the passage has been scrolled out of the pane**, which is not a corner case: a
 * selection survives scrolling, so any reader who selects something and then scrolls away still has
 * one. Placed against a rect above the pane the bar lands at a negative coordinate and is simply
 * gone — which is the same outcome by accident, but only until a later change clamps coordinates
 * into view and starts parking a bar at the top edge pointing at a passage nobody can see. Refusing
 * is the version that stays true.
 */
export function placeBar(sel: Box, wrap: Box, bar: { width: number; height: number }): Placement | null {
  // Vertical overlap only. A passage scrolled off the top or bottom has nothing on screen to point
  // at; horizontal is not checked because the column never moves sideways.
  //
  // Gated on the wrapper having been laid out, because "no layout yet" is not "off screen" and the
  // two are the same numbers: an unmeasured box is all zeros, and every selection fails an overlap
  // test against it. Refusing there would hide the bar on its first frame in the real app and in
  // every jsdom mount, on no information at all.
  if (wrap.height > 0 && (sel.top + sel.height <= wrap.top || sel.top >= wrap.top + wrap.height)) return null;
  // The selection arrives in viewport coordinates; the bar is positioned against the wrapper's box.
  const x = sel.left - wrap.left;
  const y = sel.top - wrap.top;
  const centred = x + sel.width / 2 - bar.width / 2;
  const maxLeft = wrap.width - bar.width - BAR_MARGIN;
  // `Math.min` first, then `Math.max`: on a pane narrower than the bar the two clamps disagree, and
  // this order leaves the bar at the left margin rather than off the right edge.
  const left = Math.max(BAR_MARGIN, Math.min(centred, maxLeft));

  const above = y - bar.height - BAR_GAP;
  const below = y + sel.height + BAR_GAP;
  // Below is taken only when above does not fit. A selection tall enough that BOTH fail — a drag
  // covering the whole pane — keeps the bar above, where it is clamped into view by the caller's
  // own bounds rather than parked past the bottom edge.
  const fitsAbove = above >= BAR_MARGIN;
  const fitsBelow = below + bar.height <= wrap.height - BAR_MARGIN;
  if (fitsAbove || !fitsBelow) return { left, top: Math.max(BAR_MARGIN, above), below: false };
  return { left, top: below, below: true };
}

/**
 * Is this selection one the bar should open on?
 *
 * Three refusals, each for a different reason:
 *
 *  - **Nothing but whitespace.** A click that drags two pixels is a click, and a bar that opens on it
 *    is a bar that opens when the reader is only putting the caret somewhere.
 *  - **Crossing messages.** The bar's whole offer is "quote THIS" — a selection running from an
 *    agent's answer into the next user message has no single passage behind it, and quoting the pair
 *    would hand the agent its own words attributed to nobody.
 *  - **A message still being written.** `MessageActions` is mounted only on a complete message for
 *    the same reason: text that is still arriving moves under the selection, and a bar pinned to a
 *    rect that is about to be stale is worse than no bar.
 */
export function selectionTarget(sel: Selection | null, root: HTMLElement | null): { text: string; range: Range; message: HTMLElement } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return null;
  const text = sel.toString();
  if (text.trim() === "") return null;
  const range = sel.getRangeAt(0);
  const message = messageOf(range.commonAncestorContainer, root);
  if (!message) return null;
  // `contains` is true of the node itself, so a selection that exactly spans one message passes and
  // one whose common ancestor is the column above them does not.
  if (!message.contains(range.startContainer) || !message.contains(range.endContainer)) return null;
  if (message.closest('[data-state="streaming"]')) return null;
  return { text, range, message };
}

/** The prose element a node sits in — an agent's answer or a user's message — or null for anything
 *  else the transcript draws. Tool cards, permission cards and plans are deliberately not quotable:
 *  they are structured records, and a quote of their rendered text is a quote of the interface. */
function messageOf(node: Node, root: HTMLElement): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el || !root.contains(el)) return null;
  return el.closest<HTMLElement>(".msg-assistant, .msg-user");
}

import { useEffect, useRef, type RefObject } from "react";
import { itemIdOfLeaf } from "@realm/contracts";
import { useApp } from "../../state/store";

/** How long the pointer rests on a row before its log is read ahead: a sweep down the list reads none. */
export const HOVER_PREFETCH_MS = 80;
/** How long after a session comes on screen its neighbours are read, so its own open goes first. */
export const NEIGHBOUR_PREFETCH_MS = 400;

/** The row's half of reading a session ahead of the click on it (`prefetchSession`): the pointer
 *  resting on it. Spread onto the row's button; `sessionId` null (a teammate with no chat yet) reads
 *  nothing. */
export function usePrefetchOnHover(sessionId: string | null) {
  const prefetchSession = useApp((s) => s.prefetchSession);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onPointerEnter: () => {
      if (!sessionId) return;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => prefetchSession(sessionId), HOVER_PREFETCH_MS);
    },
    onPointerLeave: () => clearTimeout(timer.current),
  };
}

/**
 * The rows just above and below the session in focus, read ahead once it is on screen: the next
 * click is most often a step up or down the list. Read off the list as drawn (`data-session` on each
 * row), which is the order the person sees, across the team and the sessions alike.
 */
export function usePrefetchNeighbours(list: RefObject<HTMLElement | null>) {
  const prefetchSession = useApp((s) => s.prefetchSession);
  const focused = useApp((s) => {
    const itemId = s.layout ? itemIdOfLeaf(s.layout, s.focusedLeafId) : null;
    const it = itemId ? s.items.find((i) => i.id === itemId) : undefined;
    return it?.kind === "session" ? it.refId : null;
  });
  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => {
      const rows = [...(list.current?.querySelectorAll<HTMLElement>(".sb-row[data-session]") ?? [])];
      const at = rows.findIndex((r) => r.dataset.session === focused);
      if (at < 0) return;
      for (const row of [rows[at - 1], rows[at + 1]]) if (row?.dataset.session) prefetchSession(row.dataset.session);
    }, NEIGHBOUR_PREFETCH_MS);
    return () => clearTimeout(timer);
  }, [focused, list, prefetchSession]);
}

import { findLeafOfItem } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { useApp } from "../state/store";

/**
 * Whether a session's row may offer a peek (W11b). The Notifications page's rows ask, and any other
 * list that carries the eye asks the same question here.
 *
 * Offered only with somewhere to be beside (`peekOwner`: a session on screen), only for a session with
 * a row to make a tab of — a quick chat has none in any space — and never for one already on screen,
 * which a click on the row goes to: two names for one move is one too many. Every space of the
 * window's profile is loaded, so its rows are read from `items`; another profile's from `allItems`.
 * Where the session lives is `sessionSpace`'s answer first, as it is for the peek itself, because a
 * notification is written once and keeps the space its session was in when it was.
 *
 * Every space's rows are re-read when any status moves, which is when a session is likeliest to have
 * been made, archived or moved somewhere the list cannot see.
 */
export function usePeekable(): (sessionId: string, spaceId: string | null) => boolean {
  const peekOwner = useApp((s) => s.peekOwner());
  const profileId = useApp((s) => s.activeProfileId);
  const spaces = useApp((s) => s.spaces);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const profileItems = useApp((s) => s.items);
  const everyItem = useApp((s) => s.allItems);
  const layout = useApp((s) => s.layout);
  const status = useApp((s) => s.sessionStatus);
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshAllItems()); }, [refreshAllItems, run, status]);
  return (sessionId, spaceId) => {
    if (!peekOwner) return false;
    const where = sessionSpace[sessionId] ?? spaceId;
    if (!spaces.some((sp) => sp.id === where && sp.profileId === profileId)) return everyItem.some((i) => i.kind === "session" && i.refId === sessionId && !i.archived);
    const it = profileItems.find((i) => i.kind === "session" && i.refId === sessionId);
    return !!it && !it.archived && !(layout && findLeafOfItem(layout, it.id));
  };
}

/**
 * A row's eye: the session as a transient tab beside the one in focus, from whichever space it is in.
 * Draw it only where `usePeekable` says so, and beside the row rather than inside it — a list row is
 * a button, and a button inside one would peek and open at once. `onPeeked` runs only when the peek
 * landed, for a list whose row has a state of its own that a look should settle.
 */
export function PeekButton({ sessionId, spaceId, name, onPeeked }: {
  sessionId: string;
  spaceId: string | null;
  /** What the row is called, so the control is named for the row it sits on. */
  name: string;
  onPeeked?: () => Promise<void>;
}) {
  const peekSession = useApp((s) => s.peekSession);
  const run = useApp((s) => s.run);
  return (
    <button type="button" className="icon-btn peek-btn" aria-label={`Peek at ${name}`}
      title="Peek — look at it beside your session, without opening it"
      onClick={() => run(async () => { if (await peekSession(sessionId, spaceId)) await onPeeked?.(); })}>
      <Icon name="peek" size={14} />
    </button>
  );
}

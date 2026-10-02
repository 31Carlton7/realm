import { Icon } from "@realm/ui";
import { useRef } from "react";
import type { Space } from "@realm/contracts";
import { spaceSummary, type LiveSession } from "../../state/attention";
import { spaceBadge, useApp } from "../../state/store";
import { SpaceIcon } from "../SpaceIcon";
import { LiveSessionRow } from "./LiveSessionRow";
import { useStripOrder } from "./SpaceStrip";
import { useLiveSessions } from "./use-live-sessions";

/**
 * Every OTHER space of the profile, one row each, below the room's own contents.
 *
 * The strip at the foot of the column already says which rooms exist and which of them has
 * something going on — sixteen pixels of glyph and a dot. What it cannot say is the room's NAME, how
 * many sessions the dot stands for, or which sessions they are, and those are what these rows are
 * for: the name, the strip's own signal with its count beside it, and a disclosure that unfolds the
 * room's live sessions — waiting on you, then working, then finished with something unread — without
 * walking into the room to look.
 *
 * Below the room's contents and inside the same scroller, never docked over them: a long list of
 * spaces then lengthens the column's scroll rather than taking height from the room you are in, so
 * nothing here can push that room's rows around. The order is the strip's (`useStripOrder`), so the
 * column never names its rooms one way below and another at the foot.
 */
export function OtherSpaces({ currentId }: { currentId: string }) {
  const spaces = useStripOrder();
  const live = useLiveSessions();
  const others = spaces.filter((s) => s.id !== currentId);
  if (others.length === 0) return null;
  return (
    <>
      <div className="group-label">Other spaces</div>
      <div className="item-list">
        {others.map((sp) => <SpaceRow key={sp.id} space={sp} live={live.filter((l) => l.spaceId === sp.id)} all={live} />)}
      </div>
    </>
  );
}

/**
 * One room, as a row: its icon and name, and at the far end what is going on in it.
 *
 * The row's anatomy is the sidebar's (ItemList): the name takes the width, the state sits in
 * `.item-trail`, and under the pointer the row's one action — the disclosure — takes the same slot.
 * A room with nothing live has nothing to unfold, so it has no disclosure and keeps its state on
 * screen under the pointer (`data-actions="0"`).
 *
 * A click on the row goes to the room. The unfolded state is remembered per room
 * (`sidebarOpenSpaces`), and the rows are built on the first unfold and kept, the shelf's way
 * (SpaceSwiper's `ArchivedSection`): folding animates too, and `inert` keeps a folded row out of the
 * tab order.
 */
function SpaceRow({ space, live, all }: { space: Space; live: LiveSession[]; all: LiveSession[] }) {
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const open = useApp((s) => s.sidebarOpenSpaces.includes(space.id));
  const setSpaceRowOpen = useApp((s) => s.setSpaceRowOpen);
  const selectSpace = useApp((s) => s.selectSpace);
  const run = useApp((s) => s.run);
  const everOpened = useRef(false);
  const summary = spaceSummary(space.id, spaceBadge(sessionStatus, sessionSpace, space.id), { status: sessionStatus, space: sessionSpace }, all);
  const hasLive = live.length > 0;
  const shown = hasLive && open;
  everOpened.current ||= shown;
  const said = summary.parts.length > 0 ? `${space.name} — ${summary.parts.join(", ")}` : null;
  const listId = `space-live-${space.id}`;
  return (
    <>
      <div className="item space-row" data-actions={hasLive ? 1 : 0}>
        <button type="button" className="item-row" aria-label={said ?? space.name} title={said ?? undefined}
          onClick={() => run(() => selectSpace(space.id))}>
          <SpaceIcon icon={space.icon} size={16} className="space-row-icon" /><span className="item-title">{space.name}</span>
          <span className="item-trail">
            {summary.mark && (
              <span className="item-tally">
                <span className="item-count">{summary.count}</span>
                <span className="status-dot item-status" data-status={summary.mark} />
              </span>
            )}
          </span>
        </button>
        {hasLive && (
          <span className="item-actions">
            <button type="button" className="item-disclose" aria-expanded={open} aria-controls={everOpened.current ? listId : undefined}
              aria-label={`Live sessions in ${space.name}`} title={open ? "Hide live sessions" : "Show live sessions"}
              onClick={() => run(() => setSpaceRowOpen(space.id, !open))}>
              <Icon name="chevronRight" size={12} />
            </button>
          </span>
        )}
      </div>
      {hasLive && everOpened.current && (
        <div className="space-live-wrap" data-open={shown || undefined}>
          <div className="space-live-clip" inert={!shown || undefined}>
            <div className="item-list space-live" id={listId}>
              {live.map((l) => <LiveSessionRow key={l.session.id} live={l} />)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

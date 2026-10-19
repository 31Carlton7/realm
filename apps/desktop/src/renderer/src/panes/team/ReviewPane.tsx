import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, TeamReviewSummary } from "@realm/contracts";
import { useApp, useAppStore } from "../../state/store";
import { Empty, Inbox } from "./review/Inbox";
import { Reader } from "./review/Reader";
import { inboxGroups, PHASE_GROUP, reviewPhase } from "./review/review-model";

const EMPTY: readonly TeamReviewSummary[] = [];

/** The bar's far end: the waiting mark, while something waits — what the Review row says, on the pane. */
export function ReviewMeta({ item }: { item: Item }) {
  const waiting = useApp((s) => (s.teams[item.refId]?.reviews ?? EMPTY).filter((r) => r.state === "waiting").length);
  return waiting > 0 ? <span className="status-dot" data-status="waiting_permission" title={`${waiting} waiting for your review`} /> : null;
}

/**
 * A space's Review: what its team made, waiting for a person's yes, beside the one being read.
 *
 * The inbox puts what needs a hand first and moves a row as it is decided — out of Waiting for you,
 * into In progress or Recent — so the list is always the work left. A decision that takes the review
 * being read out of Waiting for you moves the reader on to the next one waiting, as Mail does after
 * an archive; one that leaves it waiting (an approved post that is now yours to press) keeps it in
 * front. Too narrow for both, the pane shows one at a time: the inbox, then the review chosen, with
 * the way back at its head.
 */
export function ReviewPane({ item }: { item: Item; visible: boolean; focused?: boolean }) {
  const spaceId = item.refId;
  const team = useApp((s) => s.teams[spaceId]);
  const store = useAppStore();
  const reviews = team?.reviews ?? EMPTY;
  const selectedId = useApp((s) => s.teamReviewSelected[spaceId]);
  const selectTeamReview = useApp((s) => s.selectTeamReview);
  const groups = useMemo(() => inboxGroups(reviews), [reviews]);
  const flat = groups.flatMap((g) => g.rows);
  const selected = flat.find((r) => r.id === selectedId) ?? flat[0] ?? null;
  // A review chosen from somewhere else — the sidebar's Review row, a teammate's chat, Needs you — is
  // opened to be read: in a pane too narrow for both, the review rather than the inbox.
  const [reading, setReading] = useState(!!selectedId);
  const chosenHere = useRef(selectedId);
  useEffect(() => { if (selectedId && selectedId !== chosenHere.current) { chosenHere.current = selectedId; setReading(true); } }, [selectedId]);
  const choose = (id: string) => { chosenHere.current = id; selectTeamReview(spaceId, id); };

  const onDecided = (id: string) => {
    const waitingBefore = groups.find((g) => g.key === "waiting")?.rows ?? [];
    const at = waitingBefore.findIndex((r) => r.id === id);
    const now = store.getState().teams[spaceId]?.reviews.find((r) => r.id === id);
    if (at < 0 || !now || PHASE_GROUP[reviewPhase(now)] === "waiting") return;
    const next = waitingBefore[at + 1] ?? waitingBefore[at - 1];
    if (next) choose(next.id);
  };

  return (
    <div className="rv" data-reading={reading && selected ? "" : undefined} data-empty={selected ? undefined : ""}>
      <Inbox team={team} groups={groups} selectedId={selected?.id ?? null}
        onSelect={choose} onOpen={(id) => { choose(id); setReading(true); }} />
      {selected
        ? <Reader key={selected.id} team={team} summary={selected} onBack={() => setReading(false)} onDecided={onDecided} />
        : <div className="rv-detail rv-detail-empty"><Empty team={team} /></div>}
    </div>
  );
}

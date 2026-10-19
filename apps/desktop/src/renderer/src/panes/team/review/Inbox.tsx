import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useRef, type KeyboardEvent } from "react";
import type { TeamReviewSummary, TeamSpace } from "@realm/contracts";
import { useDissolve } from "../../../components/ScrollFades";
import { realmiteState } from "../../../components/sidebar/TeamRows";
import { useApp } from "../../../state/store";
import { ageShort, roleStateLine } from "../team-format";
import { POST_SHEET_NO_AGENT } from "../PostSheet";
import { useMovingRows } from "./inbox-motion";
import { phaseTone, reviewPhase, rowLine, rowTime, type InboxGroupKey } from "./review-model";
import { RoleMark } from "./RoleMark";

type Group = { key: InboxGroupKey; label: string; rows: TeamReviewSummary[] };

/**
 * Review's inbox: what the team made, in the order a person works through it — Waiting for you, then
 * what is under way without them, then the week's decisions. A row is who made it (the role's
 * Realmite and name), what it is and where it would go, and how long ago; the group says that it
 * waits, so the row says only what is different. ↑/↓ walk it as Mail's list does, and the row under
 * the keyboard is the one being read.
 */
export function Inbox({ team, groups, selectedId, onSelect, onOpen }: {
  team: TeamSpace | undefined; groups: Group[]; selectedId: string | null;
  onSelect: (id: string) => void; onOpen: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const moving = useMovingRows(groups);
  const flat = groups.flatMap((g) => g.rows);
  const waiting = groups.find((g) => g.key === "waiting")?.rows.length ?? 0;
  const reviews = team?.reviews ?? [];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = flat.findIndex((r) => r.id === selectedId);
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? flat.length - 1 : null;
    if (e.key === "Enter" && at >= 0) { e.preventDefault(); onOpen(flat[at]!.id); return; }
    if (to === null) return;
    const next = flat[Math.max(0, Math.min(flat.length - 1, to))];
    if (!next) return;
    e.preventDefault();
    onSelect(next.id);
    scroller.current?.querySelector<HTMLElement>(`[data-review="${next.id}"]`)?.focus();
  };

  return (
    <section className="rv-list" aria-label="Review">
      <header className="rv-list-head">
        <h2>Review</h2>
        <span className="rv-list-count t-num">{waiting > 0 ? `${waiting} waiting` : reviews.length > 0 ? "Nothing waiting" : ""}</span>
        <HoldControl spaceId={team?.spaceId ?? ""} held={team?.actsHeld ?? false} live={reviews.some((r) => r.state === "approved" && r.actsDone < r.actsTotal)} />
      </header>
      {team?.actsHeld && <HeldNote spaceId={team.spaceId} />}
      <div className="rv-scroll" ref={scroller}>
        {moving.length > 0 && (
          <div role="listbox" aria-label="Reviews" onKeyDown={onKeyDown}>
            {moving.map((g) => (
              <div key={g.key} role="group" aria-labelledby={`rv-group-${g.key}`} className="rv-group" data-group={g.key}>
                <h3 id={`rv-group-${g.key}`} className="group-label rv-group-label">{g.label}</h3>
                {g.rows.map(({ review, leaving, arrived }) => (
                  <Row key={`${review.id}${leaving ? ":gone" : ""}`} team={team} review={review} leaving={leaving} arrived={arrived}
                    selected={!leaving && review.id === selectedId} focusable={!leaving && review.id === (selectedId ?? flat[0]?.id)}
                    onSelect={() => onSelect(review.id)} onOpen={() => onOpen(review.id)} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Row({ team, review, leaving, arrived, selected, focusable, onSelect, onOpen }: {
  team: TeamSpace | undefined; review: TeamReviewSummary; leaving: boolean; arrived: boolean; selected: boolean; focusable: boolean;
  onSelect: () => void; onOpen: () => void;
}) {
  const phase = reviewPhase(review);
  const tone = phaseTone(phase);
  const line = rowLine(review);
  const who = review.roleName;
  const age = ageShort(rowTime(review));
  return (
    <div role="option" className="rv-row" data-review={leaving ? undefined : review.id} data-tone={tone} aria-selected={selected}
      data-selected={selected || undefined} data-leaving={leaving || undefined} data-arrived={arrived || undefined}
      inert={leaving || undefined} aria-hidden={leaving || undefined} tabIndex={focusable ? 0 : -1}
      aria-label={[review.title, who, line, age].filter(Boolean).join(", ")}
      onClick={() => { onSelect(); onOpen(); }}>
      <span className="rv-row-body">
        <RoleMark team={team} review={review} size={32} />
        <span className="rv-row-text">
          <span className="rv-row-top">
            <span className="rv-row-title">{review.title}</span>
            <span className="rv-row-age t-num">{age}</span>
          </span>
          <span className="rv-row-line">
            {tone === "bad" && <Icon name="alert" size={12} />}
            {tone === "ok" && <Icon name="check" size={12} />}
            {who && <span className="rv-row-who">{who}</span>}
            <span className="rv-row-what">{line}</span>
          </span>
        </span>
      </span>
    </div>
  );
}

/**
 * Nothing has come to Review yet: who on the team could send something, when the next one runs, and
 * the one promise that matters here — nothing goes out before a yes.
 */
export function Empty({ team }: { team: TeamSpace | undefined }) {
  const roles = team?.roles ?? [];
  const next = roles.filter((r) => r.cron && r.scheduleEnabled && r.nextRunAt).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0] ?? null;
  return (
    <div className="rv-empty">
      {roles.length > 0 && (
        <span className="rv-empty-team" aria-hidden="true">
          {roles.slice(0, 5).map((r) => <span key={r.id} className="rv-empty-mate"><Realmite spec={parseRealmiteSpec(r.realmite, r.id)} size={32} state={realmiteState(r)} /></span>)}
        </span>
      )}
      <h3 className="rv-empty-title">Nothing to review</h3>
      <p className="rv-empty-line">When {roles.length === 1 ? roles[0]!.name : "a teammate"} finishes a post, an email or a document, it waits here for your yes. Nothing goes out before you approve it.</p>
      {next && <p className="rv-empty-line rv-empty-next">{next.name}: {lowerFirst(roleStateLine(next))}.</p>}
    </div>
  );
}

/** "Next run Thu 9:00 AM" after a name and a colon reads as "next run Thu 9:00 AM": only the first
 *  letter of the sentence moves, never a weekday's. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The team's kill switch, at the head of its Review: "Hold posting" stops every post and send of the
 * team — a pressed one goes back to waiting, one going out is stopped — and nothing goes until it is
 * let go. Offered only while something could go out, or while it is held.
 */
function HoldControl({ spaceId, held, live }: { spaceId: string; held: boolean; live: boolean }) {
  const hold = useApp((s) => s.holdTeamActs);
  const run = useApp((s) => s.run);
  if (held || !live) return null;
  return (
    <button type="button" className="btn-quiet rv-hold" title="Stop every post, email and DM of this team until you let them go"
      onClick={() => run(() => hold(spaceId, true))}>
      <Icon name="pause" size={14} />Hold posting
    </button>
  );
}

function HeldNote({ spaceId }: { spaceId: string }) {
  const hold = useApp((s) => s.holdTeamActs);
  const run = useApp((s) => s.run);
  return (
    <div className="rv-held" role="status">
      <Icon name="pause" size={14} />
      <span title="Nothing posts or sends until you let it go, and then each still waits for its own press.">Posting is held for this team.</span>
      <button type="button" className="btn" data-no-agent={POST_SHEET_NO_AGENT} onClick={() => run(() => hold(spaceId, false))}>Let go</button>
    </div>
  );
}

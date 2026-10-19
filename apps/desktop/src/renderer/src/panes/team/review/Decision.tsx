import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { reviewVerb, verbFamily, type ActTicket, type TeamReviewDetail, type TeamReviewItem, type TeamSpace } from "@realm/contracts";
import { useApp } from "../../../state/store";
import { ACT_WORDS, plainError } from "../team-format";
import { POST_SHEET_NO_AGENT, PostSheet } from "../PostSheet";
import { approveConsequence, approvedLine, closeConsequence, finishedLine, receipt, reviewPhase, type Decision as DecisionKind } from "./review-model";
import { reviewRole, RoleMark } from "./RoleMark";

/** A press on Approve this soon after the reader changed what it shows is the tail of a double click
 *  aimed at the review before — it lands on nothing. */
const SETTLE_MS = 350;

/**
 * The decision, docked under the draft and outside its scroller so it never dissolves with it. It
 * says what Approve will do before it is pressed — where it would go, and that each post or send
 * still waits for its own press — then offers the four answers: Approve, Send back with what should
 * change (the role is woken with the words and revises in place), Reject with a reason it is told,
 * and Close, which puts it away and tells nobody. Each of the last three opens IN the dock, as the
 * prompter does, never in a sheet over the work.
 *
 * After the yes, the dock is the item's post: Post… opens its sheet, a pressed one says when it goes
 * and can be taken back, a refused one says why and offers the press again, and one that went out
 * keeps its proof. Close stays until the batch has gone out, because after the yes is when it
 * matters most: it takes back every press still waiting.
 */
export function DecisionDock({ team, detail, item, onDecided }: {
  team: TeamSpace | undefined; detail: TeamReviewDetail; item: TeamReviewItem | null;
  onDecided: (id: string, decision: DecisionKind) => void;
}) {
  const decide = useApp((s) => s.decideTeamReview);
  const requestChanges = useApp((s) => s.requestTeamReviewChanges);
  const reject = useApp((s) => s.rejectTeamReview);
  const close = useApp((s) => s.closeTeamReview);
  const cancelTicket = useApp((s) => s.cancelTeamTicket);
  const openViewer = useApp((s) => s.openViewer);
  const toast = useApp((s) => s.toast);
  const run = useApp((s) => s.run);
  const held = team?.actsHeld ?? false;
  const [asking, setAsking] = useState<"send-back" | "reject" | "close" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ActTicket | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const shownAt = useRef(Date.now());
  useEffect(() => { shownAt.current = Date.now(); setAsking(null); setError(null); }, [detail.id]);
  useEffect(() => { if (asking === "send-back" || asking === "reject") field.current?.focus(); }, [asking]);

  const role = reviewRole(team, detail.roleId);
  const roleName = detail.roleName ?? "the role";
  const wakes = role?.live?.wakeOnReview ?? false;
  const phase = reviewPhase(detail);
  const family = verbFamily(detail.verb !== undefined ? detail.verb : reviewVerb(detail.kind, detail.items));
  const pending = detail.state === "waiting" || detail.state === "changes";
  const open = pending || detail.state === "approved";
  const ticket = item ? detail.tickets.find((t) => t.itemId === item.id) ?? null : null;
  const live = sheet ? detail.tickets.find((t) => t.id === sheet.id) ?? sheet : null;
  const byHand = detail.state === "approved" && (!ticket || !ticket.adapter.connected);
  const reveal = window.realm?.files?.reveal;
  const n = detail.items.length;

  const act = (decision: DecisionKind | null, fn: () => Promise<void>, reason?: string | null) => {
    setBusy(true); setError(null);
    run(async () => {
      try {
        await fn();
        setAsking(null); setNote("");
        if (decision) {
          toast({ tone: "success", text: receipt(decision, detail, { wakes, reason: reason ?? null }), icon: decision === "approve" ? "check" : decision === "send-back" ? "undo" : undefined });
          onDecided(detail.id, decision);
        }
      } catch (e) { setError(plainError(e)); } finally { setBusy(false); }
    });
  };
  const approve = () => {
    if (Date.now() - shownAt.current < SETTLE_MS) return;
    act("approve", () => decide(detail.id, "approve"));
  };
  const submit = () => {
    const text = note.trim();
    if (asking === "send-back") { if (text) act("send-back", () => requestChanges(detail.id, text)); return; }
    if (asking === "reject") { act("reject", () => reject(detail.id, text || null), text || null); return; }
    if (asking === "close") act("close", () => close(detail.id));
  };

  const sentence = error ?? (pending && detail.state === "waiting" ? approveConsequence(detail)
    : detail.state === "approved" ? approvedLine(detail, ticket, held) : finishedLine(detail, ticket, phase));

  if (asking && open) {
    const words = asking === "send-back" ? { place: `What should ${roleName} change?`, go: `Send back to ${roleName}`, label: `What should change in ${detail.title}?` }
      : asking === "reject" ? { place: wakes ? `Why not? ${capital(roleName)} is told (optional)` : "Why not? (optional)", go: note.trim() && wakes ? `Reject and tell ${roleName}` : "Reject", label: `Why reject ${detail.title}? Optional` }
      : null;
    return (
      <div className="rv-dock composer-dock" data-asking={asking}>
        <form className="rv-dock-card rv-sendback" onSubmit={(e) => { e.preventDefault(); submit(); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); setAsking(null); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}>
          {words ? (
            <div className="rv-sendback-field">
              <RoleMark team={team} review={detail} size={24} />
              <textarea ref={field} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={words.place} aria-label={words.label} data-selectable="" />
            </div>
          ) : (
            <p className="rv-dock-ask" data-selectable="">Close “{detail.title}”? {closeConsequence(detail)}</p>
          )}
          <div className="rv-dock-row">
            <span className="rv-dock-note" role={error ? "alert" : undefined}>
              {error ?? (asking === "send-back" ? (wakes ? `${capital(roleName)} starts on a new version with your words.` : `${capital(roleName)} isn't set to wake for Review, so it won't start on this by itself.`)
                : asking === "reject" ? "Nothing of it goes out, and it can't be sent again." : "")}
            </span>
            <button type="button" className="btn" autoFocus={asking === "close"} onClick={() => setAsking(null)}>Cancel</button>
            {asking === "send-back" && <button type="submit" className="btn primary" disabled={!note.trim() || busy}>{words!.go}</button>}
            {asking === "reject" && <button type="submit" className="btn primary" disabled={busy}>{words!.go}</button>}
            {asking === "close" && <button type="submit" className="btn primary" disabled={busy}>Close</button>}
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="rv-dock composer-dock">
      <div className="rv-dock-card">
        <div className="rv-dock-row">
          <span className="rv-dock-note" role={error ? "alert" : undefined} data-tone={error || phase === "failed" ? "bad" : undefined}>{sentence}</span>
          <span className="rv-dock-actions">
            {open && (
              <span className="rv-dock-quiet">
                {detail.state !== "approved" && <button type="button" className="btn-quiet" disabled={busy} title={`Say no; ${roleName} is told why, if you say`} onClick={() => { setNote(""); setAsking("reject"); }}>Reject…</button>}
                <button type="button" className="btn-quiet" disabled={busy} title={detail.state === "approved" ? "Take back every post and send that has not gone out, and put it away" : `Put it away without sending any of it, and without telling ${roleName}`}
                  onClick={() => setAsking("close")}>Close</button>
              </span>
            )}
            {pending && (
              <>
                {detail.state === "waiting" && (
                  <button type="button" className="btn" disabled={busy} onClick={() => { setNote(""); setAsking("send-back"); }}>
                    <Icon name="undo" size={14} />Send back…
                  </button>
                )}
                {detail.state === "waiting" && (
                  <button type="button" className="btn primary rv-approve" disabled={busy} aria-busy={busy || undefined} onClick={approve}>
                    <Icon name="check" size={16} />{n > 1 ? `Approve all ${n}` : "Approve"}
                  </button>
                )}
              </>
            )}
            {detail.state === "approved" && ticket && ticket.adapter.connected && (
              <>
                {ticket.state === "ready" && !ticket.error && (
                  <button type="button" className="btn" disabled={busy} onClick={() => { setNote(""); setAsking("send-back"); }}><Icon name="undo" size={14} />Send back…</button>
                )}
                {ticket.state === "ready" && (
                  <button type="button" className="btn primary" data-no-agent={POST_SHEET_NO_AGENT} disabled={busy || held}
                    title={held ? "Posting is held for this team" : undefined} onClick={() => setSheet(ticket)}>
                    <Icon name="send" size={16} />{ticket.error ? (ACT_WORDS[ticket.kind].verb === "Post" ? "Post again…" : "Send again…") : ACT_WORDS[ticket.kind].verb === "Post" ? "Post…" : ticket.kind === "dm" ? "Send DM…" : "Send…"}
                  </button>
                )}
                {ticket.state === "scheduled" && (
                  <button type="button" className="btn" disabled={busy} onClick={() => act(null, () => cancelTicket(ticket))}>
                    {ticket.kind === "post" ? "Don't post" : "Don't send"}
                  </button>
                )}
              </>
            )}
            {ticket?.screenshot && (ticket.state === "done" || ticket.error) && (
              <button type="button" className="btn" onClick={(e) => openViewer({ files: [{ path: ticket.screenshot! }], index: 0, sessionId: detail.sessionId, spaceId: detail.spaceId, opener: e.currentTarget })}>
                <Icon name="image" size={16} />Screenshot
              </button>
            )}
            {ticket?.state === "done" && ticket.proofUrl && (
              <a className="btn" href={ticket.proofUrl} target="_blank" rel="noreferrer"><Icon name="link" size={16} />Open {ticket.kind === "post" ? "post" : "message"}</a>
            )}
            {byHand && (
              <>
                {reveal && detail.root && detail.items[0]?.files[0] && (
                  <button type="button" className="btn" onClick={() => { void reveal(`${detail.root}/${detail.items[0]!.files[0]}`); }}>Show in Finder</button>
                )}
                <button type="button" className="btn primary" disabled={busy} onClick={() => act("done", () => decide(detail.id, "done"))}>
                  <Icon name="check" size={16} />{family === "send" ? "Mark as sent" : family === "post" ? "Mark as posted" : "Mark as done"}
                </button>
              </>
            )}
          </span>
        </div>
      </div>
      {live && live.state === "ready" && <PostSheet detail={detail} ticket={live} onClose={() => setSheet(null)} />}
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

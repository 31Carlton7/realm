import { useState } from "react";
import { slotWhyWords, type ActTicket, type TeamReviewDetail } from "@realm/contracts";
import { Sheet } from "../../components/Sheet";
import { useApp } from "../../state/store";
import { ACT_WORDS, actButton, othersPhrase, plainError, slotPhrase } from "./team-format";

/** What `app_act` calls this surface when it refuses an agent's press inside it. */
export const POST_SHEET_NO_AGENT = "post sheet";

const ONE: Record<TeamReviewDetail["kind"], string> = { slideshows: "slideshow", message: "message", document: "document", report: "report" };

/**
 * The one click (the Teams plan, section 7, mock 04). The sheet names the consequence before it is
 * asked for: the account and channel, the device it goes from, WHEN — the next paced slot, never
 * "now" beside a later one — the caption, the disclosure, and the vault sign-in with "the agent never
 * receives it". Its button says the action and the time. Pressing it records the press in Electron
 * main and asks the server to act on it; the whole sheet is `data-no-agent`, so an agent driving
 * Realm's window can neither press nor tab onto it.
 *
 * Escape and Cancel leave. A refusal — the slot moved, a file changed — is said in the sheet, which
 * now shows the ticket as it is, and nothing went out.
 */
export function PostSheet({ detail, ticket, onClose }: { detail: TeamReviewDetail; ticket: ActTicket; onClose: () => void }) {
  const post = useApp((s) => s.postTeamTicket);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState(false);
  const words = ACT_WORDS[ticket.kind];
  const item = detail.items.find((i) => i.id === ticket.itemId);
  const noun = ONE[detail.kind];
  const n = detail.items.length;
  const channel = ticket.channel;
  const title = ticket.kind === "post"
    ? `Post ${noun}${n > 1 ? ` ${ticket.ord + 1}` : ""} to ${channel}?`
    : ticket.kind === "dm" ? `Send this DM to ${ticket.to ?? "them"}?` : `Send this email to ${ticket.to ?? "them"}?`;
  const who = detail.recordName ? `${detail.recordName}'s managed account` : ticket.account;
  const lede = ticket.kind === "email"
    ? `Realm sends exactly the text you approved, from ${ticket.account}. It cannot be taken back once it is sent.`
    : `Realm ${ticket.kind === "post" ? "posts it" : "sends it"}${ticket.device ? ` from ${ticket.device}` : ""}, signed in as ${who}. It cannot be taken back from Realm; ${ticket.kind === "post" ? `delete it on ${channel}` : `unsend it on ${channel}`}.`;
  const rest = detail.tickets.filter((t) => t.id !== ticket.id && t.state !== "done").map((t) => t.ord);
  const others = othersPhrase(rest, noun);
  const needsLabel = ticket.kind === "post" && ticket.disclosure !== "caption";
  const ready = ticket.adapter.connected && (!needsLabel || label) && !busy;
  const when = slotPhrase(ticket.slotAt);

  const press = async () => {
    setBusy(true); setError(null);
    try { await post(ticket, { label }); onClose(); } catch (e) { setError(plainError(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet title={title} onClose={onClose} width={560}
      footer={
        <div className="ps-foot" data-no-agent={POST_SHEET_NO_AGENT}>
          {error
            ? <span className="tp-sheet-error" role="alert">{error}</span>
            : <span className="ps-foot-note">You approve each {words.noun}.{others ? ` ${others} ${rest.length === 1 ? "stays" : "stay"} in Review.` : ""}</span>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ready} onClick={() => { void press(); }}
            title={!ticket.adapter.connected ? ticket.adapter.why ?? undefined : needsLabel && !label ? "Tick the paid-partnership label first" : undefined}>
            {busy ? `${words.verb === "Post" ? "Posting" : "Sending"}…` : actButton(ticket)}
          </button>
        </div>
      }>
      <div className="ps" data-no-agent={POST_SHEET_NO_AGENT}>
        <p className="ps-lede">{lede}</p>
        <dl className="ps-rows">
          <div><dt>Account</dt><dd>{ticket.account} · {channel}</dd></div>
          {ticket.to && <div><dt>To</dt><dd>{ticket.to}</dd></div>}
          {ticket.device && <div><dt>From</dt><dd>{ticket.device}</dd></div>}
          <div><dt>When</dt><dd className="t-num">{when === "now" ? "Now" : when}<small> · {slotWhyWords(ticket.slotWhy, ticket.kind)}</small></dd></div>
          {item?.body && <div><dt>{ticket.kind === "post" ? "Caption" : "Message"}</dt><dd className="ps-clip">{item.body}</dd></div>}
          {ticket.kind === "post" && (
            <div><dt>Disclosure</dt><dd>
              {ticket.disclosure === "caption"
                ? <>Paid partnership<small> · #ad in the caption</small></>
                : <label className="ps-check"><input type="checkbox" checked={label} onChange={(e) => setLabel(e.target.checked)} /> Turn on {channel}'s paid-partnership label<small> · the caption has no #ad</small></label>}
            </dd></div>
          )}
          {ticket.signin && <div><dt>Sign-in</dt><dd>{ticket.signin} (vault)<small> · the agent never receives it</small></dd></div>}
        </dl>
        {!ticket.adapter.connected && <p className="ps-why" role="note">{ticket.adapter.why}</p>}
      </div>
    </Sheet>
  );
}

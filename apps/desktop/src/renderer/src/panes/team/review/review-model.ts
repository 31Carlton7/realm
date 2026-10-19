import {
  isLegacyLabel, itemTarget, itemTicketKind, reviewVerb, verbFamily,
  type ActTicket, type DeliverableFormat, type TeamReviewDetail, type TeamReviewSummary,
} from "@realm/contracts";
import { ACT_WORDS, agoPhrase, slotPhrase } from "../team-format";

/**
 * Review's words, pure: which state a review is in as a person meets it, which part of the inbox it
 * sits in, and what its row, its pill and its decision say. The server's seven states are not the
 * person's — an approved batch can be waiting for a press, back with an error, or set for a slot, and
 * a put-away one can have been replaced by a newer one — so everything a surface draws is read off
 * `reviewPhase`, never off `state` directly.
 */

export type ReviewPhase =
  /* waiting for you */
  | "waiting" | "revised" | "changed" | "to-press" | "failed"
  /* in progress */
  | "changes" | "scheduled" | "by-hand"
  /* finished */
  | "approved" | "posted" | "done" | "finished" | "rejected" | "closed" | "replaced" | "withdrawn" | "put-away";

export type InboxGroupKey = "waiting" | "underway" | "recent";
/** The colour a state is drawn in: orange for what needs the person, red for what went wrong, green
 *  for what went out or was approved, and none for the rest. Never the only signal — every tone rides
 *  with a word. */
export type ReviewTone = "waiting" | "bad" | "ok" | "quiet";

type Family = "post" | "send" | null;

const familyOf = (r: Pick<TeamReviewSummary, "verb" | "kind">): Family => verbFamily(r.verb !== undefined ? r.verb : reviewVerb(r.kind, []));

export function reviewPhase(r: TeamReviewSummary): ReviewPhase {
  switch (r.state) {
    case "waiting": return r.changedSinceApproval ? "changed" : r.version > 1 ? "revised" : "waiting";
    case "changes": return "changes";
    case "approved": {
      const open = r.actsTotal - r.actsDone;
      if ((r.actsFailed ?? 0) > 0) return "failed";
      // A server that does not count presses yet: whatever has not gone out is read as waiting for one.
      if ((r.actsWaiting ?? open) > 0) return "to-press";
      if (open > 0) return "scheduled";
      if (r.actsTotal > 0) return "posted";
      return familyOf(r) ? "by-hand" : "approved";
    }
    case "done": return r.closedAs === "done" ? "finished" : r.actsTotal > 0 ? "posted" : "done";
    case "rejected": return "rejected";
    case "closed": return "closed";
    case "dismissed": return r.closedAs === "superseded" ? "replaced" : r.closedAs === "withdrawn" ? "withdrawn" : "put-away";
  }
}

export const PHASE_GROUP: Record<ReviewPhase, InboxGroupKey> = {
  waiting: "waiting", revised: "waiting", changed: "waiting", "to-press": "waiting", failed: "waiting",
  changes: "underway", scheduled: "underway", "by-hand": "underway",
  approved: "recent", posted: "recent", done: "recent", finished: "recent", rejected: "recent", closed: "recent",
  replaced: "recent", withdrawn: "recent", "put-away": "recent",
};

export const GROUP_LABEL: Record<InboxGroupKey, string> = { waiting: "Waiting for you", underway: "In progress", recent: "Recent" };

export function phaseTone(phase: ReviewPhase): ReviewTone {
  if (PHASE_GROUP[phase] === "waiting") return phase === "failed" ? "bad" : "waiting";
  if (phase === "approved" || phase === "posted" || phase === "done" || phase === "finished") return "ok";
  return "quiet";
}

/** When a row last moved: arrival for what waits, the decision (or the last change) for the rest. */
export const rowTime = (r: TeamReviewSummary): number => (PHASE_GROUP[reviewPhase(r)] === "waiting" ? r.createdAt : r.decidedAt ?? r.updatedAt);

/**
 * The inbox, in the order a person works through it: what waits for them, what is under way without
 * them, then this week's finished ones — kept long enough to find a slip, and no longer. Newest first
 * in each.
 */
export function inboxGroups(reviews: readonly TeamReviewSummary[], now = Date.now()): { key: InboxGroupKey; label: string; rows: TeamReviewSummary[] }[] {
  const week = now - 7 * 86_400_000;
  const keys: InboxGroupKey[] = ["waiting", "underway", "recent"];
  return keys.map((key) => ({
    key, label: GROUP_LABEL[key],
    rows: reviews.filter((r) => PHASE_GROUP[reviewPhase(r)] === key && (key !== "recent" || rowTime(r) >= week)).sort((a, b) => rowTime(b) - rowTime(a)),
  })).filter((g) => g.rows.length > 0);
}

/* ── what it is, and where it goes ──────────────────────────────────────────────────────────────── */

const FORMAT_NOUN: Record<DeliverableFormat, [string, string]> = {
  images: ["Picture", "pictures"], pdf: ["PDF", "PDFs"], markdown: ["Document", "documents"], email: ["Email", "emails"],
  message: ["Message", "messages"], diff: ["Diff", "diffs"], links: ["Links", "lists of links"], table: ["Table", "tables"],
  text: ["Note", "notes"], files: ["Files", "bundles of files"],
};

/** What a review IS, in plain words: "3 slideshows", "Email", "DM", "Document" — read off what its
 *  first item is drawn as, with the role's own label only where there is nothing better to say. */
export function kindWords(r: Pick<TeamReviewSummary, "kind" | "format" | "itemCount" | "verb">): string {
  const n = r.itemCount;
  if (r.kind === "slideshows") return n === 1 ? "Slideshow" : `${n} slideshows`;
  if (r.format === "message") {
    const [one, many] = r.verb === "dm" ? ["DM", "DMs"] : r.verb === "post" ? ["Post", "posts"] : ["Message", "messages"];
    return n === 1 ? one : `${n} ${many}`;
  }
  if (r.format === "email" || r.kind === "message") return n === 1 ? "Email" : `${n} emails`;
  // A file is a file: the role's own word for a bundle ("assets", "brief") says more than its format.
  if ((r.format === "pdf" || r.format === "files") && !isLegacyLabel(r.kind) && r.kind !== r.format) return r.kind;
  if (r.format) { const [one, many] = FORMAT_NOUN[r.format]; return n === 1 ? one : `${n} ${many}`; }
  return r.kind;
}

/** A channel is a place's name: "instagram" from a connector reads as the platform does. */
const channelName = (c: string): string => (c === c.toLowerCase() ? c.charAt(0).toUpperCase() + c.slice(1) : c);

/** Where a review would go, or null when it stays in Realm: "to dana@acme.com", "to @reader on
 *  Instagram", "on TikTok as @versed.nathan". */
export function destination(r: Pick<TeamReviewSummary, "verb" | "kind" | "channels" | "account" | "to">): string | null {
  const family = familyOf(r);
  const channels = r.channels.filter((c) => !/^(e-?mail|mail)$/i.test(c)).map(channelName);
  if (r.to) return `to ${r.to}${channels[0] ? ` on ${channels[0]}` : ""}`;
  if (family === "post" && channels.length > 0) return `on ${channels.join(" and ")}${r.account ? ` as ${r.account}` : ""}`;
  if (family && r.account) return `from ${r.account}`;
  return null;
}

/* ── the words a row and a pill say ─────────────────────────────────────────────────────────────── */

const pastOf = (f: Family) => (f === "send" ? "sent" : "posted");

/** The pill over the reader's title: the state in a word or two. */
export function phaseLabel(phase: ReviewPhase, r: Pick<TeamReviewSummary, "verb" | "kind">): string {
  const f = familyOf(r);
  switch (phase) {
    case "waiting": case "revised": return "Waiting for you";
    case "changed": return "Approve again";
    case "to-press": return f === "send" ? "Ready to send" : "Ready to post";
    case "failed": return f === "send" ? "Didn't send" : "Didn't post";
    case "changes": return "Sent back";
    case "scheduled": return "Scheduled";
    case "by-hand": case "approved": return "Approved";
    case "posted": return f === "send" ? "Sent" : "Posted";
    case "done": case "finished": return "Done";
    case "rejected": return "Rejected";
    case "closed": return "Closed";
    case "replaced": return "Replaced";
    case "withdrawn": return "Withdrawn";
    case "put-away": return "Put away";
  }
}

/** A row's last line. For a draft that simply waits, what it is and where it goes; for anything
 *  else, where it stands — the group already says it waits, so the line says what is different. */
export function rowLine(r: TeamReviewSummary, now = Date.now()): string {
  const phase = reviewPhase(r);
  const f = familyOf(r);
  const role = r.roleName ?? "the role";
  switch (phase) {
    case "waiting": { const where = destination(r); return where ? `${kindWords(r)} ${where}` : kindWords(r); }
    case "revised": return `Version ${r.version} · ${(r.editedItems?.length ?? 0) > 0 ? "with your edit" : "after your changes"}`;
    case "changed": return "A file changed after you approved it";
    case "to-press": { const n = r.actsWaiting ?? r.actsTotal - r.actsDone; return `Approved · ${n} to ${f === "send" ? "send" : "post"}`; }
    case "failed": {
      const n = r.actsFailed ?? 1;
      return f === "send" ? (n === 1 ? "A message didn't send" : `${n} messages didn't send`) : (n === 1 ? "A post didn't go out" : `${n} posts didn't go out`);
    }
    case "changes": return "Sent back · waiting for a new version";
    case "scheduled": {
      const verb = f === "send" ? "Sends" : "Posts";
      if (!r.nextActAt) return `${f === "send" ? "Sending" : "Posting"} now`;
      const when = slotPhrase(r.nextActAt, now);
      return when === "now" ? `${f === "send" ? "Sending" : "Posting"} now` : `${verb} ${when}`;
    }
    case "by-hand": return f === "send" ? "Approved · send it yourself" : "Approved · post it yourself";
    case "approved": return "Approved by you";
    case "posted": return r.actsTotal > 1 ? `All ${r.actsTotal} ${pastOf(f)}` : f === "send" ? "Sent" : "Posted";
    case "done": return f ? `Marked as ${pastOf(f)}` : "Marked done";
    case "finished": return `${capital(role)} finished it another way`;
    case "rejected": return r.note ? `Rejected · “${r.note}”` : "Rejected by you";
    case "closed": return r.actsDone > 0 ? `Closed · ${r.actsDone} already ${pastOf(f)}` : "Closed by you";
    case "replaced": return "Replaced by a newer version";
    case "withdrawn": return `Withdrawn by ${role}`;
    case "put-away": return "Put away";
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ── the decision ───────────────────────────────────────────────────────────────────────────────── */

/**
 * What Approve will do, said before it is pressed: what lines up, where it goes, and that each act
 * still waits for its own press — or that Realm will not send it and the person does, or that it
 * leaves Realm not at all.
 */
export function approveConsequence(detail: TeamReviewDetail): string {
  const acts = detail.items.flatMap((i) => { const k = itemTicketKind(detail.kind, i); return k ? [{ kind: k, item: i }] : []; });
  const family = verbFamily(reviewVerb(detail.kind, detail.items));
  if (acts.length > 0) {
    const first = acts[0]!;
    const t = itemTarget(first.item) ?? {};
    const n = acts.length;
    const w = ACT_WORDS[first.kind];
    const channel = t.channel ? channelName(t.channel) : null;
    if (first.kind === "post") {
      return `Approving posts nothing. ${n === 1 ? "The post" : `Each of the ${n} posts`} then waits for you to press Post${channel ? `, on ${channel}${t.account ? ` as ${t.account}` : ""}` : ""}.`;
    }
    const to = n === 1 && t.to ? ` to ${t.to}` : "";
    return `Approving sends nothing. ${n === 1 ? `The ${w.noun}${to}` : `Each of the ${n} ${w.plural}`} then waits for you to press Send${t.account ? `, from ${t.account}` : ""}.`;
  }
  if (family) {
    const t = detail.items.map(itemTarget).find((x) => x?.account) ?? null;
    return `Approving marks it ready. Realm doesn't ${family} this — you ${family} it yourself${t?.account ? ` from ${t.account}` : ""}.`;
  }
  return "Approving marks it approved. Nothing leaves Realm.";
}

/** When something happened, inside a sentence: "at 4:10 PM" today, "2h ago" or "Sat" before that —
 *  never "at 50m", which is what a clock-or-age label reads as after "at". */
export function when(ts: number, now = Date.now()): string {
  if (new Date(ts).toDateString() === new Date(now).toDateString()) return `at ${new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const min = Math.max(1, Math.round((now - ts) / 60_000));
  if (min < 60) return `${min}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `on ${agoPhrase(ts, now)}`;
}

/** The sentence the decision area says once the yes is given, for the item being read. */
export function approvedLine(detail: Pick<TeamReviewDetail, "decidedAt" | "kind" | "items" | "verb">, t: ActTicket | null, held: boolean): string {
  const at = `Approved by you${detail.decidedAt ? ` ${when(detail.decidedAt)}` : ""}.`;
  const family = verbFamily(detail.verb !== undefined ? detail.verb : reviewVerb(detail.kind, detail.items));
  if (!t) return family === "send" ? `${at} Realm doesn't send this — send it yourself.` : family === "post" ? `${at} Realm doesn't post this — post it yourself.` : at;
  const w = ACT_WORDS[t.kind];
  if (!t.adapter.connected) return `${at} ${t.adapter.why ?? ""}`.trim();
  if (held && t.state !== "done") return `${at} Posting is held for this team.`;
  switch (t.state) {
    case "ready": return t.error ? `Didn't go out: ${t.error}` : `${at} Not ${w.past.toLowerCase()} yet.`;
    case "scheduled": { const when = slotPhrase(t.slotAt); return when === "now" ? `${w.verb === "Post" ? "Posting" : "Sending"} now.` : `${w.verb}s ${when}. You can take it back until then.`; }
    case "acting": return `${w.verb === "Post" ? "Posting" : "Sending"} now.`;
    case "done": return doneLine(t);
    case "cancelled": return t.error ?? "Taken back.";
  }
}

export function doneLine(t: ActTicket | null): string {
  if (!t || t.state !== "done" || t.actedAt === null) return "Done.";
  return `${ACT_WORDS[t.kind].past} ${when(t.actedAt)}${t.kind === "post" ? ` as ${t.account}` : t.to ? ` to ${t.to}` : ""}.`;
}

/** What Close will do, said before it does it: for an approved batch, which sends it takes back and
 *  the one it may be too late for. */
export function closeConsequence(detail: TeamReviewDetail): string {
  const family = verbFamily(detail.verb !== undefined ? detail.verb : reviewVerb(detail.kind, detail.items));
  const verb = family === "post" ? "posts" : "sends";
  const role = detail.roleName ?? "the role";
  if (detail.state !== "approved" || detail.tickets.length === 0) return `Nothing of it ${verb}, and ${role} is not told.`;
  const left = detail.tickets.filter((t) => t.state === "ready" || t.state === "scheduled").length;
  const going = detail.tickets.some((t) => t.state === "acting");
  const out = detail.tickets.filter((t) => t.state === "done").length;
  return [
    left > 0 ? `Takes back ${left === 1 ? "the one" : `all ${left}`} not ${pastOf(family)} yet.` : `Nothing more of it ${verb}.`,
    going ? "One is going out right now; Realm stops it if the platform still can." : null,
    out > 0 ? `${out} already went out and ${out === 1 ? "stays" : "stay"} out.` : null,
  ].filter(Boolean).join(" ");
}

/** A finished review's last word, in the decision area where its buttons were. */
export function finishedLine(detail: TeamReviewDetail, t: ActTicket | null, phase: ReviewPhase): string {
  const at = detail.decidedAt ? ` ${when(detail.decidedAt)}` : "";
  const family = verbFamily(detail.verb !== undefined ? detail.verb : reviewVerb(detail.kind, detail.items));
  const role = detail.roleName ?? "The role";
  switch (phase) {
    case "changes": return `You sent it back${at}${detail.note ? `: “${detail.note}”` : "."} It comes back here as a new version.`;
    case "rejected": return `You rejected it${at}${detail.note ? `: “${detail.note}”` : "."} Nothing of it goes out.`;
    case "closed": {
      const out = detail.tickets.filter((x) => x.state === "done").length;
      if (detail.tickets.some((x) => x.state === "acting")) return `You closed it${at}. One was already going out; Realm is stopping it if the platform still can.`;
      if (out > 0) return `You closed it${at}. ${out} ${out === 1 ? "was" : "were"} already ${pastOf(family)}; nothing more goes out.`;
      return `You closed it${at}. Nothing of it goes out.`;
    }
    case "replaced": return `${role} replaced it with a newer version${detail.note ? `: “${detail.note}”` : "."}`;
    case "withdrawn": return `${role} withdrew it${detail.note ? `: “${detail.note}”` : "."}`;
    case "finished": return `${role} finished it another way${detail.note ? `: “${detail.note}”` : "."}`;
    case "put-away": return `Put away${detail.note ? `: “${detail.note}”` : "."}`;
    case "posted": return doneLine(t);
    case "done": return `Marked as ${family ? pastOf(family) : "done"}${at}.`;
    default: return "";
  }
}

/* ── receipts ───────────────────────────────────────────────────────────────────────────────────── */

export type Decision = "approve" | "send-back" | "reject" | "close" | "done";

/** The toast a decision leaves: what happened, and what did not. `wakes` is whether the role is
 *  woken by Review, which decides whether it hears about a send-back or a reason now. */
export function receipt(decision: Decision, detail: Pick<TeamReviewDetail, "title" | "roleName" | "kind" | "items" | "verb">, o: { wakes: boolean; reason?: string | null }): string {
  const t = `“${detail.title}”`;
  const role = detail.roleName ?? "the role";
  const family = verbFamily(detail.verb !== undefined ? detail.verb : reviewVerb(detail.kind, detail.items));
  const acts = detail.items.some((i) => itemTicketKind(detail.kind, i) !== null);
  switch (decision) {
    case "approve":
      return acts ? `Approved ${t}. Nothing ${family === "send" ? "sends" : "posts"} until you press ${family === "send" ? "Send" : "Post"}.` : `Approved ${t}.`;
    case "send-back": return o.wakes ? `Sent ${t} back to ${role}.` : `Sent ${t} back. ${capital(role)} isn't set to wake for Review, so it won't start on this by itself.`;
    case "reject": return o.reason && o.wakes ? `Rejected ${t}. ${capital(role)} is told why.` : `Rejected ${t}.`;
    case "close": return `Closed ${t}. Nothing more of it goes out.`;
    case "done": return `Marked ${t} as ${family ? pastOf(family) : "done"}.`;
  }
}

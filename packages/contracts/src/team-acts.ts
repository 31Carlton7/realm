import { z } from "zod";
import { IdSchema } from "./entities";

/**
 * Teams Phase 3: approve, then act.
 *
 * Approving a batch says "this is right". Acting — a post, an email, a DM — is a second step, one
 * TICKET per outward action: bound to the exact bytes that were approved (their hash), to one account
 * and one consequence, and given the next PACED slot for that account. A ticket acts only after a
 * person's click on its post sheet in Realm's own window; an agent can propose work for Review and
 * nothing more (the owner's decision, 10-08: "approve the batch, then one click per post at the next
 * paced slot. No auto-posting for now").
 *
 * The pacing below is the guardrail the 10-07 night asked for, when an unattended agent sent 105 DMs
 * from a personal account until Instagram stopped it. It is enforced by realm-server when a ticket is
 * planned, when it is pressed, and again when it acts. Nothing raises it: the numbers are here, not in
 * a setting or a record an agent could edit.
 */

export const ACT_KINDS = ["post", "email", "dm"] as const;
export const ActKindSchema = z.enum(ACT_KINDS);
export type ActKind = z.infer<typeof ActKindSchema>;

export type ActPacing = {
  /** Per account (channel + handle), per local day. */
  perDay: number;
  /** At least this long between two acts from one account. */
  gapMs: number;
  /** Per team, per local day, over all its accounts. */
  teamPerDay: number;
};

/** The defaults, which are also the ceilings. Posts: 3 a day, 2 h apart. DMs: 15 a day per account
 *  AND per team, 3 min apart. Email: the person's own sender, so looser, but still paced. */
export const ACT_PACING: Record<ActKind, ActPacing> = {
  post: { perDay: 3, gapMs: 2 * 60 * 60_000, teamPerDay: 12 },
  dm: { perDay: 15, gapMs: 3 * 60_000, teamPerDay: 15 },
  email: { perDay: 20, gapMs: 60_000, teamPerDay: 40 },
};

/** The hours (local) a slot may fall in: nothing is planned for 3 a.m. */
export const ACT_WINDOW = { startHour: 8, endHour: 22 } as const;

/** A press is the sheet's time, kept: a ticket that would act more than this after the time its
 *  button showed is refused and re-planned, so nothing goes out at a time the person did not see. */
export const ACT_SLOT_TOLERANCE_MS = 60_000;

/** A pressed ticket whose slot passed while Realm was not running goes back to the person rather
 *  than acting late. */
export const ACT_LATE_MS = 15 * 60_000;

/** Which kind of act an item is, from its review's kind and its channel. Null: nothing outward. */
export function actKindFor(reviewKind: string, channel: string | undefined | null): ActKind | null {
  const c = (channel ?? "").trim().toLowerCase();
  if (!c) return null;
  if (reviewKind === "slideshows") return "post";
  if (reviewKind === "message") return c === "email" || c === "mail" ? "email" : "dm";
  return null;
}

/** One act already planned, scheduled or done — what a new slot is planned around. */
export type PlannedAct = { at: number; kind: ActKind; channel: string; account: string; spaceId: string };

/** The account an act goes out as: one channel's one handle. */
export const actAccountKey = (channel: string, account: string): string => `${channel.trim().toLowerCase()}|${account.trim().toLowerCase()}`;

function dayStart(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function nextDayAt(t: number, hour: number): number { const d = new Date(dayStart(t)); d.setDate(d.getDate() + 1); d.setHours(hour, 0, 0, 0); return d.getTime(); }
function sameDayAt(t: number, hour: number): number { const d = new Date(dayStart(t)); d.setHours(hour, 0, 0, 0); return d.getTime(); }

export type SlotWhy = "next" | "gap" | "account_day" | "team_day" | "window";
const WHY_WEIGHT: Record<SlotWhy, number> = { next: 0, gap: 1, window: 2, team_day: 3, account_day: 4 };

/** Whether an act at `t` keeps every rule against `others`, and the first rule it breaks. */
export function slotProblem(act: Omit<PlannedAct, "at">, t: number, others: readonly PlannedAct[], pacing: ActPacing = ACT_PACING[act.kind]): Exclude<SlotWhy, "next"> | null {
  const hour = new Date(t).getHours();
  if (hour < ACT_WINDOW.startHour || hour >= ACT_WINDOW.endHour) return "window";
  const key = actAccountKey(act.channel, act.account);
  const day = dayStart(t);
  const mine = others.filter((o) => o.kind === act.kind && actAccountKey(o.channel, o.account) === key);
  if (mine.some((o) => Math.abs(o.at - t) < pacing.gapMs)) return "gap";
  if (mine.filter((o) => dayStart(o.at) === day).length >= pacing.perDay) return "account_day";
  if (others.filter((o) => o.kind === act.kind && o.spaceId === act.spaceId && dayStart(o.at) === day).length >= pacing.teamPerDay) return "team_day";
  return null;
}

/**
 * The earliest time at or after `from` that an act may happen: inside the day's window, at least the
 * gap from every other act of its kind on the same account, under the account's daily cap and the
 * team's. Pure, so the renderer and the server agree, and a fake clock tests it.
 */
export function planSlot(act: Omit<PlannedAct, "at">, from: number, others: readonly PlannedAct[], pacing: ActPacing = ACT_PACING[act.kind]): { at: number; why: SlotWhy } {
  let t = from;
  let why: SlotWhy = "next";
  const key = actAccountKey(act.channel, act.account);
  for (let i = 0; i < 5_000; i++) {
    const problem = slotProblem(act, t, others, pacing);
    if (problem === null) return { at: t, why };
    // The reason said is the weightiest rule that moved it: a full day over the gap that preceded it.
    if (WHY_WEIGHT[problem] > WHY_WEIGHT[why]) why = problem;
    if (problem === "window") {
      t = new Date(t).getHours() < ACT_WINDOW.startHour ? sameDayAt(t, ACT_WINDOW.startHour) : nextDayAt(t, ACT_WINDOW.startHour);
    } else if (problem === "account_day" || problem === "team_day") {
      t = nextDayAt(t, ACT_WINDOW.startHour);
    } else {
      const near = others.filter((o) => o.kind === act.kind && actAccountKey(o.channel, o.account) === key && Math.abs(o.at - t) < pacing.gapMs);
      t = Math.max(...near.map((o) => o.at)) + pacing.gapMs;
    }
  }
  throw new Error("no slot in reach for this act");
}

/* ────────────────────────────── tickets ────────────────────────────── */

/** `ready`: approved, waiting for its one click. `scheduled`: pressed, waits for its slot. `acting`:
 *  the platform adapter has it. `done`: it went out, with proof. `cancelled`: what was approved
 *  changed, the review moved on, or the person took it back. A failed act goes back to `ready` with
 *  its error and screenshot; it never retries on its own. */
export const TICKET_STATES = ["ready", "scheduled", "acting", "done", "cancelled"] as const;
export const TicketStateSchema = z.enum(TICKET_STATES);
export type TicketState = z.infer<typeof TicketStateSchema>;

/** How a post discloses a paid partnership: in its caption (#ad), or by the platform's label, which
 *  the person ticks on the sheet and the adapter turns on. A post with neither is refused. */
export const DISCLOSURE = /#ad\b|#sponsored\b|#paidpartnership\b|paid partnership/i;

export const ActAdapterStatusSchema = z.object({
  connected: z.boolean(),
  /** What it is, in words: "Fake TikTok (test)", "TikTok". */
  label: z.string(),
  /** Why it cannot act, when it cannot. */
  why: z.string().nullable(),
});
export type ActAdapterStatus = z.infer<typeof ActAdapterStatusSchema>;

export const ActTicketSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  reviewId: IdSchema,
  itemId: IdSchema,
  /** The item's place in its batch, for "slideshow 1 of 6". */
  ord: z.number().int(),
  kind: ActKindSchema,
  channel: z.string(),
  account: z.string(),
  /** A DM's or an email's recipient. */
  to: z.string().nullable(),
  /** What the record says about the account: where it posts from, its sign-in's name, its consent. */
  device: z.string().nullable(),
  signin: z.string().nullable(),
  consent: z.string().nullable(),
  /** The hash of what was approved, which is what it will send. */
  contentHash: z.string(),
  /** `caption` when the caption discloses, null when the sheet must ask for the platform's label. */
  disclosure: z.enum(["caption", "label"]).nullable(),
  state: TicketStateSchema,
  /** When it is planned (ready) or set (scheduled) to act. */
  slotAt: z.number().int(),
  /** Why that time — "the next slot", or the rule that pushed it. */
  slotWhy: z.enum(["next", "gap", "account_day", "team_day", "window"]),
  pressedAt: z.number().int().nullable(),
  actedAt: z.number().int().nullable(),
  proofUrl: z.string().nullable(),
  /** Absolute path of the proof screenshot — or, after a failure, of the failure's screenshot. */
  screenshot: z.string().nullable(),
  error: z.string().nullable(),
  /** This account's acts of this kind today, and its cap — "1 of 3 posts today". */
  todayCount: z.number().int(),
  todayCap: z.number().int(),
  adapter: ActAdapterStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ActTicket = z.infer<typeof ActTicketSchema>;

/** Words for a slot's reason, as the sheet's "When" row says them. */
export function slotWhyWords(why: SlotWhy, kind: ActKind): string {
  const noun = kind === "post" ? "posts" : kind === "dm" ? "DMs" : "emails";
  switch (why) {
    case "next": return "the next slot for this account";
    case "gap": return kind === "post" ? "the next slot for this account, 2 hours after the one before" : `the next slot for this account, ${Math.round(ACT_PACING[kind].gapMs / 60_000)} minutes after the one before`;
    case "account_day": return `this account's ${ACT_PACING[kind].perDay} ${noun} for the day are taken`;
    case "team_day": return `the team's ${ACT_PACING[kind].teamPerDay} ${noun} for the day are taken`;
    case "window": return `Realm plans ${noun} between ${hour12(ACT_WINDOW.startHour)} and ${hour12(ACT_WINDOW.endHour)}`;
  }
}

const hour12 = (h: number): string => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

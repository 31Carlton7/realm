import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ACT_LATE_MS, ACT_PACING, ACT_SLOT_TOLERANCE_MS, DISCLOSURE, actAccountKey, actKindFor, itemActKind, itemTarget, planSlot, recordAccounts, slotProblem, slotWhyWords,
  type ActKind, type ActTicket, type ParsedRecord, type PlannedAct, type RecordAccount, type ReviewTarget, type SlotWhy,
} from "@realm/contracts";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError, RpcError } from "../../store/rows";
import { bytesHash, itemHash } from "../item-hash";
import type { ReviewRow, TeamStore } from "../store";
import type { ActAdapter } from "./adapters";
import type { ActStore, TicketRow } from "./store";

/** What main answers about a press: whether the person clicked this ticket's button on its sheet, in
 *  Realm's own window, in the last moments — and what that sheet showed. One-shot: asking consumes it. */
export type TicketPress = { pressed: boolean; label: boolean; slotAt: number | null };

/** How long an adapter may take over one act before Realm gives up on it and says so. */
const ACT_TIMEOUT_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Approve → act (Teams Phase 3).
 *
 * **Approval issues tickets; it acts on nothing.** Each approved item aimed at an account becomes one
 * ticket: one account, one consequence, bound to the hash of what was approved, planned into the next
 * paced slot for that account (`planSlot`). Pacing is per account and per team, by kind, and the
 * numbers are `ACT_PACING`'s — nothing here reads them from a setting or a record.
 *
 * **A ticket acts only on the person's click.** `post` asks main, over the bridge, whether Realm's own
 * post sheet was pressed for exactly this ticket and these bytes (`presses.consume`). An agent holding
 * the RPC token, or driving Realm's window, cannot make that press: the IPC is the renderer's alone
 * and the sheet is `data-no-agent`. There is no MCP tool here at all.
 *
 * **Checked three times.** At issue, at the press, and at the slot: the hash of the bytes (staged and
 * re-hashed before the adapter sees them), the record's consent for the account, the disclosure, the
 * account's and team's caps and gaps, and the team's hold. A failure goes back to the person with its
 * screenshot; nothing retries on its own. Every step is a line in the team's activity, and every act
 * that went out keeps its URL and a screenshot.
 */
export class ActService {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Map<string, AbortController>();
  private closing = false;

  constructor(private readonly d: {
    store: ActStore;
    team: Pick<TeamStore, "review" | "items" | "appendActivity" | "setReviewState">;
    /** The space folder a review's files live in. */
    rootForSpace: (spaceId: string) => string | null;
    /** A record of the team's memory, parsed — where an account's consent, device and sign-in are. */
    record: (spaceId: string, recordPath: string) => ParsedRecord | null;
    /** Main's answer about the post sheet (`main/ticket-presses.ts`, over the bridge). */
    presses: { consume(ticketId: string, contentHash: string): Promise<TicketPress> };
    /** The platform for a channel: the fake in tests and live checks, a not-connected stub otherwise. */
    adapter: (channel: string, kind: ActKind) => ActAdapter;
    /** Where proofs and staged copies go — under Realm's home, never the space folder. */
    proofDir: string;
    rpc: Pick<RpcServer, "broadcast">;
    clock?: () => number;
  }) {}

  private now(): number { return this.d.clock ? this.d.clock() : Date.now(); }

  /** Boot: arm every pressed ticket, and hand back any that was mid-act when Realm stopped — whether it
   *  went out is the platform's to say, so it is never re-sent blind. */
  start(): void {
    for (const t of this.d.store.scheduled()) {
      if (t.state === "acting") {
        this.d.store.transition(t.id, "acting", { state: "ready", pressedAt: null,
          error: "Realm stopped while this was going out. Check the platform before you press again." });
        this.log(t.spaceId, "realm", "act_failed", t, { why: "interrupted" });
      } else this.arm(t);
    }
  }

  close(): void {
    this.closing = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const c of this.inflight.values()) c.abort();
  }

  /* ═══════════════════════════ issuing ═══════════════════════════ */

  /**
   * A batch was approved: one ticket per item aimed at an account, each in the next free slot after
   * the one before it. An item that already has a ticket for the same bytes keeps it; one whose bytes
   * changed has its old ticket cancelled. Idempotent — approving twice issues nothing new.
   */
  issue(reviewId: string): ActTicket[] {
    const r = this.d.team.review(reviewId);
    if (!r || r.state !== "approved") return [];
    const items = this.d.team.items(reviewId, r.version);
    const current = new Set(items.map((i) => i.id));
    for (const t of this.d.store.forReview(reviewId)) {
      if (!current.has(t.itemId) && (t.state === "ready" || t.state === "scheduled")) this.cancel(t, "a newer version replaced it");
    }
    let issued = 0;
    const skipped: string[] = [];
    for (const item of items) {
      // The item's action, or for a legacy row its target — a channel act either way (post, dm, email).
      const target = itemTarget(item);
      const kind = itemActKind(r.kind, item);
      if (!kind || !target?.account || !target.channel || !item.approvedHash) continue;
      if ((kind === "dm" || kind === "email") && !target.to) { skipped.push(`item ${item.ord + 1} names nobody to send it to`); continue; }
      const live = this.d.store.liveForItem(item.id);
      if (live && (live.state === "done" || live.state === "acting" || live.contentHash === item.approvedHash)) continue;
      if (live) this.cancel(live, "what was approved changed");
      const slot = this.plan({ kind, channel: target.channel, account: target.account, spaceId: r.spaceId }, this.now(), null);
      this.d.store.insert({
        spaceId: r.spaceId, reviewId, itemId: item.id, kind, channel: target.channel, account: target.account, to: target.to ?? null,
        contentHash: item.approvedHash, slotAt: slot.at, slotWhy: slot.why,
      });
      issued++;
    }
    if (issued > 0 || skipped.length > 0) {
      this.d.team.appendActivity({ spaceId: r.spaceId, actor: "realm", verb: "issued_tickets", object: r.title,
        detail: { reviewId, tickets: issued, ...(skipped.length ? { skipped } : {}) } });
      this.changed(r.spaceId);
    }
    return this.tickets(reviewId);
  }

  /** The review moved on — changes asked, dismissed, marked done by hand, or a file changed after the
   *  yes: every ticket not yet out is cancelled, and one going out is stopped. */
  cancelForReview(reviewId: string, why: string): void {
    let spaceId: string | null = null;
    for (const t of this.d.store.forReview(reviewId)) {
      if (t.state === "ready" || t.state === "scheduled") { this.cancel(t, why); spaceId = t.spaceId; }
      if (t.state === "acting") this.inflight.get(t.id)?.abort();
    }
    if (spaceId) this.changed(spaceId);
  }

  /* ═══════════════════════════ reading ═══════════════════════════ */

  tickets(reviewId: string): ActTicket[] {
    return this.d.store.forReview(reviewId).map((t) => this.view(t));
  }

  ticketsForSpace(spaceId: string): ActTicket[] {
    return this.d.store.forSpace(spaceId).map((t) => this.view(t));
  }

  ticket(id: string): ActTicket { return this.view(this.must(id)); }

  counts(reviewId: string): { total: number; done: number } {
    const all = this.d.store.forReview(reviewId);
    return { total: all.length, done: all.filter((t) => t.state === "done").length };
  }

  held(spaceId: string): boolean { return this.d.store.held(spaceId); }

  /** "1 of 3 posts today for this account" — what went out or is set to, today. */
  today(kind: ActKind, channel: string, account: string): { count: number; cap: number } {
    const key = actAccountKey(channel, account);
    const day = startOfDay(this.now());
    const count = this.d.store.pacingSince(kind, day, Number.MAX_SAFE_INTEGER)
      .filter((t) => t.state !== "ready" && actAccountKey(t.channel, t.account) === key && startOfDay(t.actedAt ?? t.slotAt) === day).length;
    return { count, cap: ACT_PACING[kind].perDay };
  }

  private view(t: TicketRow): ActTicket {
    const fresh = t.state === "ready" ? this.refreshSlot(t) : t;
    const r = this.d.team.review(t.reviewId);
    const item = r ? this.d.team.items(t.reviewId).find((i) => i.id === t.itemId) ?? null : null;
    const acct = r ? this.account(r, t) : null;
    const today = this.today(t.kind, t.channel, t.account);
    return {
      id: t.id, spaceId: t.spaceId, reviewId: t.reviewId, itemId: t.itemId, ord: item?.ord ?? 0,
      kind: t.kind, channel: t.channel, account: t.account, to: t.to,
      device: acct?.parts.device ?? null, signin: acct?.parts.vault ?? null, consent: acct?.parts.consent ?? null,
      contentHash: t.contentHash,
      disclosure: t.kind !== "post" ? null : DISCLOSURE.test(item?.body ?? "") ? "caption" : t.disclosure === "label" ? "label" : null,
      state: fresh.state, slotAt: fresh.slotAt, slotWhy: fresh.slotWhy,
      pressedAt: fresh.pressedAt, actedAt: fresh.actedAt, proofUrl: fresh.proofUrl, screenshot: fresh.screenshot, error: fresh.error,
      todayCount: today.count, todayCap: today.cap,
      adapter: this.d.adapter(t.channel, t.kind).status(t.channel, t.kind),
      createdAt: t.createdAt, updatedAt: fresh.updatedAt,
    };
  }

  /* ═══════════════════════════ the press ═══════════════════════════ */

  /**
   * The person pressed "Post at 4:10 PM" on this ticket's sheet. Main is asked first whether that is
   * true; then everything the sheet showed is checked again, and the ticket is set for its slot — or
   * acts now, when the slot is now.
   */
  async post(id: string): Promise<ActTicket> {
    const t = this.must(id);
    if (t.state !== "ready") throw new RpcError("TEAM_TICKET_STATE", t.state === "done" ? "this already went out" : `this is ${t.state}, not waiting for a press`);
    const press = await this.d.presses.consume(t.id, t.contentHash).catch(() => ({ pressed: false, label: false, slotAt: null }) as TicketPress);
    if (!press.pressed) {
      this.refuse(t, "no_press", "nobody pressed its sheet");
      throw new RpcError("TEAM_TICKET_NOT_PRESSED", "Only a person's click on this ticket's sheet in Realm's window can post or send it. An agent or a script cannot; it can only send work to Review.");
    }
    if (this.d.store.held(t.spaceId)) throw new RpcError("TEAM_ACTS_HELD", "Posting is held for this team. Let it go again from Review first.");
    const { review, problem } = this.stillApproved(t);
    if (problem) throw problem;
    const why = this.consentProblem(review!, t);
    if (why) { this.refuse(t, "no_consent", why); throw new RpcError("TEAM_NO_CONSENT", why); }
    const item = this.d.team.items(t.reviewId).find((i) => i.id === t.itemId)!;
    const disclosure = t.kind !== "post" ? null : DISCLOSURE.test(item.body ?? "") ? "caption" : press.label ? "label" : null;
    if (t.kind === "post" && !disclosure) {
      this.refuse(t, "no_disclosure", "no paid-partnership disclosure");
      throw new RpcError("TEAM_NO_DISCLOSURE", "This post discloses no paid partnership: its caption has no #ad, and the platform's label was not ticked.");
    }
    const status = this.d.adapter(t.channel, t.kind).status(t.channel, t.kind);
    if (!status.connected) throw new RpcError("TEAM_ACT_NOT_CONNECTED", status.why ?? `${status.label} is not connected`);

    // The slot the sheet showed is the one it acts in, or none: a time the person did not see is a
    // different decision, so it is said and the press is not spent on it.
    const slot = this.refreshSlot(t);
    const shown = press.slotAt ?? slot.slotAt;
    if (Math.abs(slot.slotAt - shown) > ACT_SLOT_TOLERANCE_MS) {
      this.refuse(t, "slot_moved", slotWhyWords(slot.slotWhy, t.kind), { slotAt: slot.slotAt });
      throw new RpcError("TEAM_SLOT_MOVED", `Nothing went out: the next slot for ${t.account} moved — ${slotWhyWords(slot.slotWhy, t.kind)}. Press again to ${t.kind === "post" ? "post" : "send"} it then.`);
    }
    if (!this.d.store.transition(t.id, "ready", { state: "scheduled", pressedAt: this.now(), disclosure, error: null })) {
      throw new RpcError("TEAM_TICKET_STATE", "this ticket moved while it was being pressed");
    }
    const set = this.must(id);
    this.log(t.spaceId, "user", "pressed", set, { slotAt: set.slotAt, disclosure, hash: set.contentHash });
    this.arm(set);
    this.changed(t.spaceId);
    return this.view(this.must(id));
  }

  /** Take a press back before its slot, or put a ticket away. Only ever narrows. */
  cancelTicket(id: string): ActTicket {
    const t = this.must(id);
    if (t.state === "scheduled") {
      this.clearTimer(t.id);
      this.d.store.transition(t.id, "scheduled", { state: "ready", pressedAt: null, error: null });
      this.log(t.spaceId, "user", "cancelled_ticket", t, { back: "ready" });
    } else if (t.state === "ready") {
      this.cancel(t, "you cancelled it");
    } else if (t.state === "acting") {
      this.inflight.get(t.id)?.abort();
    }
    this.changed(t.spaceId);
    return this.view(this.must(id));
  }

  /**
   * The kill switch. Held: every pressed ticket of the team goes back to waiting for a press, one going
   * out is stopped, and no press is taken until it is let go. Letting go acts on nothing by itself —
   * each ticket needs its press again — so either direction is safe to offer anywhere.
   */
  hold(spaceId: string, held: boolean): { held: boolean } {
    if (held) {
      this.d.store.hold(spaceId);
      for (const t of this.d.store.forSpace(spaceId)) {
        if (t.state === "scheduled") {
          this.clearTimer(t.id);
          this.d.store.transition(t.id, "scheduled", { state: "ready", pressedAt: null, error: HELD });
        }
        if (t.state === "acting") this.inflight.get(t.id)?.abort();
      }
      this.d.team.appendActivity({ spaceId, actor: "user", verb: "held_acts", object: null, detail: {} });
    } else {
      this.d.store.release(spaceId);
      // The hold's own note goes with it; each ticket still waits for its press.
      for (const t of this.d.store.forSpace(spaceId)) if (t.state === "ready" && t.error === HELD) this.d.store.update(t.id, { error: null });
      this.d.team.appendActivity({ spaceId, actor: "user", verb: "resumed_acts", object: null, detail: {} });
    }
    this.changed(spaceId);
    return { held: this.d.store.held(spaceId) };
  }

  /* ═══════════════════════════ acting ═══════════════════════════ */

  private arm(t: TicketRow): void {
    if (this.closing) return;
    this.clearTimer(t.id);
    const wait = t.slotAt - this.now();
    if (wait <= 0) { void this.execute(t.id); return; }
    const timer = setTimeout(() => { this.timers.delete(t.id); const again = this.d.store.ticket(t.id); if (again) this.arm(again); }, Math.min(wait, 2 ** 31 - 1));
    timer.unref?.();
    this.timers.set(t.id, timer);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  /** The slot came: check everything again, stage the approved bytes, hand them to the platform, and
   *  keep what it left behind. Exported for tests through `post` and the clock; never called by a tool. */
  async execute(id: string): Promise<void> {
    const t = this.d.store.ticket(id);
    if (!t || t.state !== "scheduled" || this.closing) return;
    const back = (error: string, verb: "refused" | "act_failed", detail: Record<string, unknown>) => {
      this.d.store.transition(t.id, "scheduled", { state: "ready", pressedAt: null, error });
      this.log(t.spaceId, "realm", verb, t, detail);
      this.changed(t.spaceId);
    };
    if (this.d.store.held(t.spaceId)) return back("Held with the rest of the team's posts.", "refused", { why: "held" });
    // A timer that fired early (or a clock that moved) waits for the slot: nothing acts before it.
    if (this.now() < t.slotAt - 1_000) { this.arm(t); return; }
    if (this.now() - t.slotAt > ACT_LATE_MS) return back("Missed its slot while Realm was not running. Press again to set a new one.", "refused", { why: "missed_slot" });
    // Pacing against what actually went out or is set to — not against another ticket's plan.
    const others = this.pacingOthers(t, false);
    // At the slot it was pressed for, which `post` checked; late by at most `ACT_LATE_MS`.
    const problem = slotProblem({ kind: t.kind, channel: t.channel, account: t.account, spaceId: t.spaceId }, t.slotAt, others);
    if (problem) return back(`Not sent: ${slotWhyWords(problem, t.kind)}. Press again for the next slot.`, "refused", { why: problem });
    // The bytes are checked once the copies are staged, below — the copies are what the platform gets.
    const { review, problem: gone } = this.stillApproved(t, false);
    if (gone || !review) return back(gone?.message ?? "the review moved on", "refused", { why: "review" });
    const consent = this.consentProblem(review, t);
    if (consent) return back(consent, "refused", { why: "no_consent" });
    if (!this.d.store.transition(t.id, "scheduled", { state: "acting" })) return;

    const item = this.d.team.items(t.reviewId).find((i) => i.id === t.itemId)!;
    const staged = this.stage(t, item.files);
    if (!staged) {
      this.d.store.transition(t.id, "acting", { state: "cancelled", error: "A file changed after you approved it, so it was not sent." });
      this.log(t.spaceId, "realm", "refused", t, { why: "changed_since_approval" });
      this.changed(t.spaceId);
      return;
    }
    const acct = this.account(review, t);
    const controller = new AbortController();
    this.inflight.set(t.id, controller);
    const timeout = setTimeout(() => controller.abort(), ACT_TIMEOUT_MS);
    timeout.unref?.();
    const shot = join(this.d.proofDir, t.spaceId, `${t.id}.png`);
    let result: Awaited<ReturnType<ActAdapter["act"]>>;
    try {
      result = await this.d.adapter(t.channel, t.kind).act({
        ticketId: t.id, kind: t.kind, channel: t.channel, account: t.account, to: t.to, files: staged, body: item.body,
        paidPartnershipLabel: t.disclosure === "label", device: acct?.parts.device ?? null, signin: acct?.parts.vault ?? null,
        screenshotPath: shot, signal: controller.signal,
      });
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e), screenshot: null };
    } finally {
      clearTimeout(timeout);
      this.inflight.delete(t.id);
    }
    if (result.ok) {
      this.d.store.transition(t.id, "acting", { state: "done", actedAt: this.now(), proofUrl: result.url, screenshot: result.screenshot, error: null });
      this.log(t.spaceId, "realm", "acted", t, { url: result.url, screenshot: result.screenshot, hash: t.contentHash, to: t.to });
      const all = this.d.store.forReview(t.reviewId);
      if (all.length > 0 && all.every((x) => x.state === "done")) {
        this.d.team.setReviewState(t.reviewId, "done", { decided: true });
        this.d.team.appendActivity({ spaceId: t.spaceId, actor: "realm", verb: "marked_done", object: review.title, detail: { reviewId: t.reviewId, acts: all.length } });
      }
    } else {
      // Never retried: the person sees the error and its screenshot, and presses again or not.
      this.d.store.transition(t.id, "acting", { state: "ready", pressedAt: null, error: result.error, screenshot: result.screenshot });
      this.log(t.spaceId, "realm", "act_failed", t, { error: result.error, screenshot: result.screenshot });
    }
    rmSync(join(this.d.proofDir, t.spaceId, t.id), { recursive: true, force: true });
    this.changed(t.spaceId);
  }

  /** Copy the item's files out of the space folder and hash the COPIES: the bytes the platform gets
   *  are the bytes checked, whatever happens to the originals meanwhile. Null when they differ from
   *  what was approved. */
  private stage(t: TicketRow, files: string[]): string[] | null {
    const root = this.d.rootForSpace(t.spaceId);
    if (!root) return null;
    const dir = join(this.d.proofDir, t.spaceId, t.id);
    mkdirSync(dir, { recursive: true });
    const copies = new Map<string, string>();
    try {
      files.forEach((f, i) => {
        const to = join(dir, `${String(i).padStart(2, "0")}-${basename(f)}`);
        copyFileSync(join(root, f), to);
        copies.set(f, to);
      });
    } catch { return null; }
    const item = this.d.team.items(t.reviewId).find((i) => i.id === t.itemId);
    const hash = itemHash(files, (f) => { const p = copies.get(f); return p && existsSync(p) ? bytesHash(readFileSync(p)) : "missing"; }, item?.body ?? null);
    return hash === t.contentHash ? files.map((f) => copies.get(f)!) : null;
  }

  /* ═══════════════════════════ rules ═══════════════════════════ */

  /** The review is still approved, at the version this ticket is for, and (with `bytes`) its files
   *  still hash to what was approved. A ticket that fails the last is cancelled: a yes to one picture
   *  is not a yes to another. */
  private stillApproved(t: TicketRow, bytes = true): { review: ReviewRow | null; problem: RpcError | null } {
    const review = this.d.team.review(t.reviewId);
    if (!review || review.state !== "approved") return { review, problem: new RpcError("TEAM_REVIEW_STATE", "this batch is no longer approved") };
    const item = this.d.team.items(t.reviewId, review.version).find((i) => i.id === t.itemId);
    if (!item) return { review, problem: new RpcError("TEAM_REVIEW_STATE", "a newer version of this batch replaced it") };
    if (!bytes) return { review, problem: null };
    const root = this.d.rootForSpace(t.spaceId);
    const now = root ? itemHash(item.files, (f) => { const p = join(root, f); return existsSync(p) ? bytesHash(readFileSync(p)) : "missing"; }, item.body) : null;
    if (now !== t.contentHash || item.approvedHash !== t.contentHash) {
      this.cancel(t, "what was approved changed");
      this.log(t.spaceId, "realm", "refused", t, { why: "changed_since_approval" });
      this.changed(t.spaceId);
      return { review, problem: new RpcError("TEAM_TICKET_CHANGED", "A file changed after you approved it, so this was not sent. It needs your yes again in Review.") };
    }
    return { review, problem: null };
  }

  /** A post or DM goes out only as an account whose record line says `consent:`. An email is the
   *  person's own sender, and needs none. */
  private consentProblem(review: ReviewRow, t: TicketRow): string | null {
    if (t.kind === "email") return null;
    if (!review.recordPath) return `${t.account} is not named in a creator's record, so Realm has no consent to act as it.`;
    const acct = this.account(review, t);
    if (!acct) return `${review.recordPath} has no Accounts line for ${t.account} on ${t.channel}.`;
    if (!acct.parts.consent) return `${review.recordPath} names ${t.account} without consent: — Realm acts as a creator's account only with their written yes, named on its line.`;
    return null;
  }

  private account(review: ReviewRow, t: Pick<TicketRow, "channel" | "account">): RecordAccount | null {
    const record = review.recordPath ? this.d.record(review.spaceId, review.recordPath) : null;
    if (!record) return null;
    const handle = t.account.toLowerCase(); const ch = t.channel.toLowerCase();
    return recordAccounts(record).find((a) => a.handle?.toLowerCase() === handle
      && (a.channel.toLowerCase().includes(ch) || ch.includes(a.channel.toLowerCase()))) ?? null;
  }

  /** What a slot is planned around: every other act of the kind that went out, is set to, or (when
   *  planning) holds a reservation ahead — across teams, so two teams sharing an account share its cap. */
  private pacingOthers(t: Pick<TicketRow, "id" | "kind">, withReservations: boolean): PlannedAct[] {
    const since = startOfDay(this.now()) - DAY_MS;
    // A waiting ticket holds its slot while the slot is ahead (or only just passed): one nobody pressed
    // in time reserved nothing.
    return this.d.store.pacingSince(t.kind, since, withReservations ? this.now() - ACT_SLOT_TOLERANCE_MS : Number.MAX_SAFE_INTEGER)
      .filter((o) => o.id !== t.id && (withReservations || o.state !== "ready"))
      .map((o) => ({ at: o.state === "done" ? o.actedAt ?? o.slotAt : o.slotAt, kind: o.kind, channel: o.channel, account: o.account, spaceId: o.spaceId }));
  }

  private plan(act: Omit<PlannedAct, "at">, from: number, self: string | null): { at: number; why: SlotWhy } {
    return planSlot(act, from, this.pacingOthers({ id: self ?? "", kind: act.kind }, true));
  }

  /**
   * A waiting ticket's slot, kept while it is ahead and still keeps every rule against what went out or
   * is set to, and planned again from now when it has passed or no longer fits. Other waiting tickets'
   * plans are not held against it here: they spread a batch when it is issued, but an act that went
   * out a few seconds after its slot must not push every plan behind it by a whole gap. Whichever is
   * pressed first takes the slot, and the other is planned again when it is next read.
   */
  private refreshSlot(t: TicketRow): TicketRow {
    const act = { kind: t.kind, channel: t.channel, account: t.account, spaceId: t.spaceId };
    const now = this.now();
    const real = this.pacingOthers(t, false);
    // A slot only just passed is still the one the sheet shows ("Post now").
    if (t.slotAt >= now - ACT_SLOT_TOLERANCE_MS && slotProblem(act, t.slotAt, real) === null) return t;
    const next = planSlot(act, now, real);
    return this.d.store.update(t.id, { slotAt: next.at, slotWhy: next.why });
  }

  private cancel(t: TicketRow, why: string): void {
    this.clearTimer(t.id);
    if (this.d.store.transition(t.id, t.state, { state: "cancelled", error: why })) this.log(t.spaceId, "realm", "cancelled_ticket", t, { why });
  }

  private refuse(t: TicketRow, why: string, words: string, extra: Record<string, unknown> = {}): void {
    this.log(t.spaceId, "realm", "refused", t, { why, words, ...extra });
    this.changed(t.spaceId);
  }

  private must(id: string): TicketRow {
    const t = this.d.store.ticket(id);
    if (!t) throw new NotFoundError("ticket", id);
    return t;
  }

  private log(spaceId: string, actor: string, verb: string, t: TicketRow, detail: Record<string, unknown>): void {
    this.d.team.appendActivity({ spaceId, actor, verb, object: `${t.account}${t.to ? ` → ${t.to}` : ""}`,
      detail: { ticketId: t.id, reviewId: t.reviewId, kind: t.kind, channel: t.channel, account: t.account, ...detail } });
  }

  private changed(spaceId: string): void { this.d.rpc.broadcast("team.changed", { spaceId }); }
}

const HELD = "Held with the rest of the team's posts. Press again once posting is let go.";

function startOfDay(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** An item's target as the ticket names it — exported for the Review checks. */
export const targetKind = (reviewKind: string, target: ReviewTarget | null): ActKind | null => actKindFor(reviewKind, target?.channel);

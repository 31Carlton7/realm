/**
 * The one click that lets a team's act ticket go out (Teams Phase 3).
 *
 * A press is made HERE, from Realm's own window, over renderer IPC — `team:press-ticket`, sent by the
 * post sheet's button, which carries `data-no-agent` so an agent driving Realm's window cannot press
 * it. realm-server asks for it over the bridge (`teamTicketPress`) when `team.ticketPost` is called,
 * and the answer is consumed as it is given: one press, one act. Without a press here, the server
 * refuses, so nothing holding the RPC token can post by calling the method itself.
 *
 * A press names the ticket, the hash of what the sheet showed, the time on its button, and whether the
 * platform's paid-partnership label was ticked. It lasts a short while, for the round trip.
 */
export type TicketPressInput = { ticketId: string; contentHash: string; slotAt: number; label: boolean };

export const PRESS_TTL_MS = 30_000;

type Press = TicketPressInput & { at: number };

export class TicketPresses {
  private presses = new Map<string, Press>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The sheet's button was clicked. Refuses what is not a ticket's shape — the renderer is trusted to
   *  be Realm's, not to send well-formed input. */
  press(input: unknown): boolean {
    const p = (input ?? {}) as Record<string, unknown>;
    if (typeof p.ticketId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(p.ticketId)) return false;
    if (typeof p.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(p.contentHash)) return false;
    if (typeof p.slotAt !== "number" || !Number.isFinite(p.slotAt)) return false;
    this.sweep();
    this.presses.set(p.ticketId, { ticketId: p.ticketId, contentHash: p.contentHash, slotAt: p.slotAt, label: p.label === true, at: this.now() });
    return true;
  }

  /** realm-server's question: was this ticket pressed, for these bytes, just now? Spent by asking. */
  consume(ticketId: unknown, contentHash: unknown): { pressed: boolean; label: boolean; slotAt: number | null } {
    this.sweep();
    const p = typeof ticketId === "string" ? this.presses.get(ticketId) : undefined;
    if (!p) return { pressed: false, label: false, slotAt: null };
    this.presses.delete(p.ticketId);
    if (p.contentHash !== contentHash) return { pressed: false, label: false, slotAt: null };
    return { pressed: true, label: p.label, slotAt: p.slotAt };
  }

  private sweep(): void {
    const cutoff = this.now() - PRESS_TTL_MS;
    for (const [id, p] of this.presses) if (p.at < cutoff) this.presses.delete(id);
  }
}

import { describe, expect, it } from "vitest";
import { PRESS_TTL_MS, TicketPresses } from "./ticket-presses";

const ID = "01M07DEZCTCDT8QKVJ9MBTS6WX";
const HASH = "a".repeat(64);

describe("a post sheet's press, as main keeps it", () => {
  it("is answered once: the server's question spends it", () => {
    const p = new TicketPresses();
    expect(p.press({ ticketId: ID, contentHash: HASH, slotAt: 5, label: true })).toBe(true);
    // THE MUTANT: `consume` reads without deleting — one click would post on every call after it.
    expect(p.consume(ID, HASH)).toEqual({ pressed: true, label: true, slotAt: 5 });
    expect(p.consume(ID, HASH)).toEqual({ pressed: false, label: false, slotAt: null });
  });

  it("is for the bytes the sheet showed: another hash is no press", () => {
    const p = new TicketPresses();
    p.press({ ticketId: ID, contentHash: HASH, slotAt: 5, label: false });
    expect(p.consume(ID, "b".repeat(64)).pressed).toBe(false);
  });

  it("lasts the round trip and no longer", () => {
    let now = 1_000;
    const p = new TicketPresses(() => now);
    p.press({ ticketId: ID, contentHash: HASH, slotAt: 5, label: false });
    now += PRESS_TTL_MS + 1;
    expect(p.consume(ID, HASH).pressed).toBe(false);
  });

  it("takes nothing that is not a ticket's shape", () => {
    const p = new TicketPresses();
    expect(p.press({ ticketId: "../x", contentHash: HASH, slotAt: 5 })).toBe(false);
    expect(p.press({ ticketId: ID, contentHash: "nope", slotAt: 5 })).toBe(false);
    expect(p.press(null)).toBe(false);
    expect(p.consume(ID, HASH).pressed).toBe(false);
  });
});

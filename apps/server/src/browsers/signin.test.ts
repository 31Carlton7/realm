import { describe, expect, it } from "vitest";
import { AGENT_SIGNIN_KEY } from "@realm/contracts";
import { SIGNIN_TICKET_MS, SignInTickets } from "./signin";

const SPACE = "space1";
const CONSENT = "https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A1";
const ORDINARY = "https://example.com/docs";

function setup(opts: { enabled?: boolean } = {}) {
  let now = 1_000_000;
  const stored = new Map<string, unknown>();
  if (opts.enabled) stored.set(`${AGENT_SIGNIN_KEY}:${SPACE}`, true);
  const tickets = new SignInTickets({
    settings: { get: (k) => stored.get(k) as never },
    now: () => now,
  });
  return { tickets, advance: (ms: number) => { now += ms; }, stored };
}

describe("the switch", () => {
  it("is off until a space says otherwise", () => {
    expect(setup().tickets.enabled(SPACE)).toBe(false);
  });

  /**
   * THE MUTANT: mint regardless and let `allowsAct` consult the switch. The two would then disagree
   * for any ticket minted before the user turned the switch back off — and the ticket, not the
   * switch, is what the act asks.
   */
  it("mints nothing while it is off, so the assisted flow stays assisted", () => {
    const { tickets } = setup();
    tickets.mint(SPACE, "b1", CONSENT);
    expect(tickets.allowsAct(SPACE, "b1", CONSENT)).toBe(false);
  });
});

describe("what a ticket covers", () => {
  it("lets the agent act on the exact page Realm put it on", () => {
    const { tickets } = setup({ enabled: true });
    tickets.mint(SPACE, "b1", CONSENT);
    expect(tickets.allowsAct(SPACE, "b1", CONSENT)).toBe(true);
  });

  it("follows the flow's own query rewrites", () => {
    // A consent flow rewrites `state`, adds `prompt=consent` on a second pass, carries a
    // `login_hint` back from the account picker. A ticket that stopped matching at the first
    // redirect would be a feature that never once worked.
    const { tickets } = setup({ enabled: true });
    tickets.mint(SPACE, "b1", CONSENT);
    expect(tickets.allowsAct(SPACE, "b1", `${CONSENT}&prompt=consent&state=xyz`)).toBe(true);
  });

  /**
   * THE MUTANT: compare origin only. Every authorization endpoint on a host would then be covered by
   * a ticket minted for one of them — and on a host like accounts.google.com that is most of the
   * consent screens in existence.
   */
  it("does not cover a different endpoint on the same host", () => {
    const { tickets } = setup({ enabled: true });
    tickets.mint(SPACE, "b1", CONSENT);
    expect(tickets.allowsAct(SPACE, "b1", "https://claude.ai/oauth/authorize-admin?client_id=a&redirect_uri=b")).toBe(false);
  });

  it("does not cover another pane, or another space", () => {
    const { tickets } = setup({ enabled: true });
    tickets.mint(SPACE, "b1", CONSENT);
    expect(tickets.allowsAct(SPACE, "b2", CONSENT)).toBe(false);
    expect(tickets.allowsAct("spaceOTHER", "b1", CONSENT)).toBe(false);
  });

  /** THE MUTANT: never expire. An abandoned sign-in would leave the pane licensed indefinitely, so
   *  the next consent page to land in it — by redirect, by link, by anything — would be clickable. */
  it("stops standing once it has expired", () => {
    const { tickets, advance } = setup({ enabled: true });
    tickets.mint(SPACE, "b1", CONSENT);
    advance(SIGNIN_TICKET_MS);
    expect(tickets.allowsAct(SPACE, "b1", CONSENT)).toBe(false);
  });

  it("can be handed back early", () => {
    const { tickets } = setup({ enabled: true });
    tickets.mint(SPACE, "b1", CONSENT);
    tickets.release("b1");
    expect(tickets.allowsAct(SPACE, "b1", CONSENT)).toBe(false);
  });
});

describe("pages that are none of its business", () => {
  it("never stands in the way of an ordinary page", () => {
    // THE MUTANT: gate every act. The tickets would become a permission system for the whole
    // browser, which is the broker's job and not this class's.
    const { tickets } = setup();
    expect(tickets.allowsAct(SPACE, "b1", ORDINARY)).toBe(true);
  });

  it("allows an act on a pane whose URL cannot be read", () => {
    // A guard against the common case, not a boundary — `isOAuthConsentUrl` says as much of itself,
    // and refusing on "we could not tell" would break acting on any pane mid-navigation.
    const { tickets } = setup();
    expect(tickets.allowsAct(SPACE, "b1", undefined)).toBe(true);
  });
});

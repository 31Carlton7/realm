import { AGENT_SIGNIN_DEFAULT, AGENT_SIGNIN_KEY } from "@realm/contracts";
import { isOAuthConsentUrl } from "./guards";
import type { SettingsStore } from "../store/settings";

/**
 * Permission to finish ONE sign-in, on ONE consent page, for a short while.
 *
 * ## The hole this closes first
 *
 * `guards.ts` refuses agent navigation to a consent URL in every mode, because "a click on
 * Authorize grants a durable capability no per-action permission prompt can express". It guards
 * `browser_open` and `browser_navigate` — the two tools that carry a URL — and its own comment
 * admits it cannot see "a same-site link the agent CLICKS", because `browser_act` has no URL in its
 * arguments to test.
 *
 * That admission is larger than it reads. The guard's stated purpose is that an agent must never
 * reach a consent screen, and the act it exists to prevent is pressing the button on one — which
 * was ungated in every mode, including `plan`'s sibling `bypassPermissions`, for any pane that got
 * there by a redirect, a click, or the user's own address bar. So `browser_act` now asks where the
 * pane IS before it acts, and this class is what can answer "yes, deliberately" for the one case
 * where pressing that button is the whole point.
 *
 * ## Why a ticket rather than a setting alone
 *
 * A space-wide "agents may use consent screens" switch would be a standing grant to authorize
 * anything, on any origin, for as long as it stayed on. What makes an automated sign-in defensible
 * is not that the user enabled a mode — it is PROVENANCE: this exact URL was read off the screen of
 * a terminal Realm itself started, running a login command out of `AGENT_CLI_COMMANDS`, seconds ago.
 * Nothing the agent said produced it and no page influenced it. A ticket is that provenance, made
 * checkable.
 *
 * So the switch decides whether tickets are ever minted, and the ticket decides whether one act is
 * allowed. With the switch off the sign-in flow still runs — Realm still opens the terminal, still
 * types the command, still puts the consent page in front of the user — and the last click is
 * theirs. That is the assisted flow, and it is the default.
 *
 * ## What a ticket deliberately is not
 *
 * It is not a credential and it authorizes no navigation: an agent still cannot steer a pane onto a
 * consent screen, ticket or no ticket. It only says that acting on a pane ALREADY showing this URL
 * is expected. It expires on a clock rather than on the flow finishing, because the failure mode
 * worth designing against is a sign-in that is abandoned halfway — a ticket that outlived its flow
 * would sit there licensing the next consent page to land in that pane.
 */

/** How long a minted ticket stands. Long enough for a real consent page — which may redirect
 *  through an identity provider and ask the user to pick an account — and short enough that an
 *  abandoned sign-in stops being a standing permission before anybody could use it as one. */
export const SIGNIN_TICKET_MS = 5 * 60 * 1000;

type Ticket = { spaceId: string; url: string; expiresAt: number };

export class SignInTickets {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly d: {
    settings: Pick<SettingsStore, "get">;
    /** Injected so a test can move the clock rather than wait five minutes. */
    now?: () => number;
  }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** Is this space willing for Realm to finish a sign-in on its own? Off unless someone said so. */
  enabled(spaceId: string): boolean {
    const raw = this.d.settings.get(`${AGENT_SIGNIN_KEY}:${spaceId}`);
    return raw === undefined || raw === null ? AGENT_SIGNIN_DEFAULT : raw === true;
  }

  /**
   * Record that Realm put this pane on this consent URL as part of a sign-in it is running.
   *
   * A no-op when the space has not enabled it — the flow calls this unconditionally and the switch
   * is read HERE, so there is exactly one place that decides, rather than one at every call site.
   */
  mint(spaceId: string, browserId: string, url: string): void {
    if (!this.enabled(spaceId)) return;
    this.tickets.set(browserId, { spaceId, url, expiresAt: this.now() + SIGNIN_TICKET_MS });
  }

  /**
   * May an agent act on this pane, given the URL it is actually showing?
   *
   * Anything that is not a consent page is none of this class's business and passes. A consent page
   * passes only against a live ticket, for the same space, naming the same page.
   *
   * "Same page" compares origin and path and ignores the query, deliberately: a consent flow rewrites
   * its own query as it goes — `state`, `step`, `login_hint`, a `prompt=consent` on the second pass —
   * and a ticket that stopped matching at the first redirect would be a feature that never once
   * worked. Origin and path are what say WHICH authorization endpoint this is, which is the part the
   * provenance is about.
   */
  allowsAct(spaceId: string, browserId: string, url: string | undefined): boolean {
    if (!url || !isOAuthConsentUrl(url)) return true;
    const ticket = this.tickets.get(browserId);
    if (!ticket) return false;
    if (ticket.expiresAt <= this.now()) { this.tickets.delete(browserId); return false; }
    return ticket.spaceId === spaceId && samePage(ticket.url, url);
  }

  /** Give a ticket back early — the sign-in finished, or the pane closed. */
  release(browserId: string): void { this.tickets.delete(browserId); }
}

function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch { return false; }
}

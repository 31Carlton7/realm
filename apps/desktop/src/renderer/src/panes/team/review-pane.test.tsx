import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ActTicket, TeamReviewDetail } from "@realm/contracts";
import { ReviewPane } from "./ReviewPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, space, teamReview, teamRole, teamSpace } from "../../state/store.test-fakes";

/**
 * The Review pane: the list beside the batch being read, the decision outside the scroller, and a
 * card that never moves out from under the press that decided it. Each test names its mutant.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const slides = ["deck/01.png", "deck/02.png", "deck/03.png"];
const detail = (id: string, title: string, over: Partial<TeamReviewDetail> = {}): TeamReviewDetail => ({
  ...teamReview(id, "s1", title, { roleName: "Content Producer", itemCount: 2, thumb: slides[0]!, channels: ["TikTok"], recordPath: "creators/nathan.md" }),
  items: [0, 1].map((ord) => ({ id: `${id}-i${ord}`, reviewId: id, version: 1, ord, files: slides, body: `caption ${ord + 1} #ad`,
    target: { channel: "TikTok", account: "@versed.nathan" }, contentHash: "h", approvedHash: null, actState: "none" })),
  previous: [], costUsd: 0.84, durationMs: 360_000, runCapUsd: 3, model: "sonnet", recordName: "Nathan Beyenhof",
  checks: [{ ok: true, title: "Posts as @versed.nathan on TikTok", detail: "managed with consent (contract §4)" }, { ok: null, title: "Realm does not post yet", detail: "Post it by hand." }],
  ledger: [{ ts: 1, glyph: "note", text: "Read Nathan Beyenhof", detail: "creators/nathan.md" }, { ts: 2, glyph: "inbox", text: "Sent 2 items to Review", detail: "Content Producer, sonnet, $0.84 of its $3 run cap" }],
  root: "/spaces/versed", tickets: [], ...over,
});

async function mount(firstOver: Partial<TeamReviewDetail> = {}) {
  const first = detail("v1", "6 slideshows for Nathan", firstOver);
  const second = detail("v2", "Weekly check-in", { kind: "message", itemCount: 1, thumb: null });
  const api = fakeApi({
    profiles: [profile("p1", "Work")],
    spaces: [space("s1", "p1", "Versed")],
    items: { s1: [item("i-review", "s1", { kind: "review", refId: "s1", title: "Review" })] },
    teams: [teamSpace("s1", [teamRole("r1", "s1", "Content Producer")], [first, second].map(({ items: _i, previous: _p, costUsd: _c, durationMs: _d, runCapUsd: _r, model: _m, recordName: _n, checks: _k, ledger: _l, root: _o, ...s }) => s))],
    teamReviews: { v1: first, v2: second },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  const it = store.getState().items.find((i) => i.kind === "review") ?? item("i-review", "s1", { kind: "review", refId: "s1", title: "Review" });
  render(<StoreContext.Provider value={store}><ReviewPane item={it} visible /></StoreContext.Provider>);
  await screen.findByRole("heading", { level: 1 });
  return { api, store };
}

describe("the Review pane", () => {
  it("reads the batch with its record, its role and its dollars and minutes in the byline", async () => {
    // THE MUTANT: a byline without the run's cost — every run shows its dollars (the plan, 9.5).
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("6 slideshows for Nathan — slideshow 1 of 2");
    const byline = document.querySelector(".rv-byline")!;
    expect(byline).toHaveTextContent("For Nathan Beyenhof");
    expect(byline).toHaveTextContent("made by Content Producer");
    expect(byline).toHaveTextContent("$0.84 · 6m");
    expect(document.querySelectorAll(".rv-slide")).toHaveLength(3);
  });

  it("quotes the note a version answers without doubling its full stop", async () => {
    // THE MUTANT: a period after the closing quote of a note that already ended in one — “…posts.”.
    await mount({ version: 2, note: "Make it warmer." });
    const line = await screen.findByText(/Version 2, after you asked/);
    expect(line.textContent).toContain("“Make it warmer.”");
    expect(line.textContent).not.toContain("”.");
  });

  it("says a message is sent, not posted", async () => {
    // THE MUTANT: "Before it can post" over an email draft.
    await mount();
    fireEvent.click(document.querySelector('[data-review="v2"]')!);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Weekly check-in"));
    expect(screen.getByRole("heading", { name: "Before it can send" })).toBeInTheDocument();
    expect(screen.getByText("Nothing sends until you approve.")).toBeInTheDocument();
  });

  it("keeps the decision outside the scroller, so it never dissolves with the slides", async () => {
    // THE MUTANT: the bar moved inside `.rv-detail-scroll`, where the mask takes it.
    await mount();
    const bar = document.querySelector(".rv-decide")!;
    expect(bar.closest(".rv-detail-scroll")).toBeNull();
    expect(bar.closest(".rv-detail")).not.toBeNull();
    expect(within(bar as HTMLElement).getByRole("button", { name: /Approve all 2/ })).toBeEnabled();
  });

  it("approves the batch and leaves its card where it was, its state line swapped in place", async () => {
    // THE MUTANT: the card jumps to "Approved, not posted" under the pointer that approved it.
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: /Approve all 2/ }));
    await waitFor(() => expect(api.calls).toContain("teamReviewDecide:v1:approve"));
    await waitFor(() => expect(document.querySelector(".rv-decide-note")).toHaveTextContent(/Approved by you/));
    const groups = [...document.querySelectorAll(".rv-group")].map((g) => g.textContent);
    expect(groups).toEqual(["Waiting for you"]);
    const card = document.querySelector('[data-review="v1"]')!;
    expect(card.querySelector(".rv-state")).toHaveTextContent("Approved by you");
  });

  it("asks what should change in a field under the bar, and sends the words to the role", async () => {
    // THE MUTANT: Request changes sending with no note, or Escape closing the pane instead of the field.
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const field = screen.getByRole("textbox", { name: /What should change/ });
    expect(screen.getByRole("button", { name: "Send to Content Producer" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "Shorter hook" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Content Producer" }));
    await waitFor(() => expect(api.calls).toContain("teamReviewRequestChanges:v1:Shorter hook"));
  });

  it("walks the list with the arrow keys", async () => {
    // THE MUTANT: the list as a column of buttons the keyboard has to Tab through one by one.
    const { store } = await mount();
    const card = document.querySelector<HTMLElement>('[data-review="v1"]')!;
    card.focus();
    fireEvent.keyDown(card, { key: "ArrowDown" });
    await waitFor(() => expect(store.getState().teamReviewSelected["s1"]).toBe("v2"));
  });
});

/** A ticket for item `ord` of v1, ready for its press — what an approved batch carries. */
const ticket = (ord: number, over: Partial<ActTicket> = {}): ActTicket => ({
  id: `01M07DEZCTCDT8QKVJ9MBTS6W${ord}`, spaceId: "s1", reviewId: "v1", itemId: `v1-i${ord}`, ord, kind: "post", channel: "TikTok",
  account: "@versed.nathan", to: null, device: "Lab iPhone 2", signin: "tiktok.com/nathan", consent: "contract §4", contentHash: "h".repeat(64),
  disclosure: "caption", state: "ready", slotAt: Date.now() + 2 * 3_600_000, slotWhy: "next", pressedAt: null, actedAt: null, proofUrl: null,
  screenshot: null, error: null, todayCount: 0, todayCap: 3, adapter: { connected: true, label: "TikTok (fake, for testing)", why: null },
  createdAt: 0, updatedAt: 0, ...over,
});
const approvedBatch = (tickets: ActTicket[]): Partial<TeamReviewDetail> => ({ state: "approved", decidedAt: Date.now(), actsTotal: tickets.length, actsDone: 0, tickets });
const sheet = () => screen.getByRole("dialog");
/** Mounted with v1 approved — it sits under "Approved, not posted", so it is chosen to be read. */
async function mountApproved(over: Partial<TeamReviewDetail>) {
  const m = await mount(over);
  fireEvent.click(document.querySelector('[data-review="v1"]')!);
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("6 slideshows for Nathan"));
  return m;
}

describe("the post sheet", () => {
  it("opens from Post… on the item being read, and names the consequence: account, device, when, caption, disclosure, sign-in", async () => {
    await mountApproved(approvedBatch([ticket(0), ticket(1)]));
    fireEvent.click(screen.getByRole("button", { name: "Post…" }));
    expect(sheet()).toHaveAccessibleName("Post slideshow 1 to TikTok?");
    expect(sheet()).toHaveTextContent("Realm posts it from Lab iPhone 2, signed in as Nathan Beyenhof's managed account. It cannot be taken back from Realm; delete it on TikTok.");
    const rows = Object.fromEntries([...sheet().querySelectorAll(".ps-rows > div")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]));
    expect(rows).toMatchObject({ Account: "@versed.nathan · TikTok", From: "Lab iPhone 2", Caption: "caption 1 #ad", Disclosure: "Paid partnership · #ad in the caption", "Sign-in": "tiktok.com/nathan (vault) · the agent never receives it" });
    expect(rows.When).toMatch(/today · the next slot for this account$/);
    // THE MUTANT: "Post now" beside a later slot — the button says the action and the time.
    expect(within(sheet()).getByRole("button", { name: /^Post at \d{1,2}:\d{2}\s?[AP]M$/ })).toBeEnabled();
    expect(sheet()).toHaveTextContent("You approve each post. Slideshow 2 stays in Review.");
  });

  it("is out of an agent's reach: the sheet, its button and the Post… that opens it are all data-no-agent", async () => {
    // THE MUTANT: the attribute dropped from the sheet — `app_act` would press "Post at …" for the agent.
    await mountApproved(approvedBatch([ticket(0)]));
    const open = screen.getByRole("button", { name: "Post…" });
    expect(open.closest("[data-no-agent]")).not.toBeNull();
    fireEvent.click(open);
    const button = within(sheet()).getByRole("button", { name: /^Post at/ });
    expect(button.closest("[data-no-agent]")).not.toBeNull();
    expect(sheet().querySelector(".ps")!.closest("[data-no-agent]")).not.toBeNull();
  });

  it("one click presses main first, then asks the server to act on that press — for exactly the time it showed", async () => {
    // THE MUTANT: the server asked without the press (or before it) — refused every time.
    const t = ticket(0);
    const { api } = await mountApproved(approvedBatch([t]));
    fireEvent.click(screen.getByRole("button", { name: "Post…" }));
    fireEvent.click(within(sheet()).getByRole("button", { name: /^Post at/ }));
    await waitFor(() => expect(api.calls).toContain(`teamTicketPost:${t.id}`));
    const press = api.calls.indexOf(`teamTicketPress:${t.id}:${t.slotAt}:false`);
    expect(press).toBeGreaterThan(-1);
    expect(press).toBeLessThan(api.calls.indexOf(`teamTicketPost:${t.id}`));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("will not post a caption with no #ad until the platform's paid-partnership label is ticked, and sends the tick with the press", async () => {
    const t = ticket(0, { disclosure: null });
    const { api } = await mountApproved(approvedBatch([t]));
    fireEvent.click(screen.getByRole("button", { name: "Post…" }));
    const button = within(sheet()).getByRole("button", { name: /^Post at/ });
    // THE MUTANT: the button live with nothing disclosing the partnership.
    expect(button).toBeDisabled();
    fireEvent.click(within(sheet()).getByRole("checkbox", { name: /paid-partnership label/ }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.calls).toContain(`teamTicketPress:${t.id}:${t.slotAt}:true`));
  });

  it("a pressed ticket says when it goes and can be taken back; one that went out keeps its proof", async () => {
    await mountApproved(approvedBatch([ticket(0, { state: "scheduled", pressedAt: 1 }), ticket(1, { state: "done", actedAt: Date.now(), proofUrl: "https://fake-platform.invalid/tiktok/x/1", screenshot: "/home/team-proof/s1/1.png" })]));
    expect(document.querySelector(".rv-decide-note")).toHaveTextContent(/^Posts at .+ today\. You can take it back until then\.$/);
    expect(screen.getByRole("button", { name: "Don't post" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "2" }));
    expect(document.querySelector(".rv-decide-note")).toHaveTextContent(/^Posted at .+ as @versed\.nathan\.$/);
    expect(screen.getByRole("link", { name: "Open post" })).toHaveAttribute("href", "https://fake-platform.invalid/tiktok/x/1");
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeInTheDocument();
  });

  it("where the platform is not connected, offers no Post… and keeps the by-hand path, saying why", async () => {
    // THE MUTANT: a Post… that can only ever be refused (design.md: offer a capability only where it exists).
    await mountApproved(approvedBatch([ticket(0, { adapter: { connected: false, label: "TikTok", why: "Realm can't post to TikTok yet." } })]));
    expect(screen.queryByRole("button", { name: "Post…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as posted" })).toBeInTheDocument();
    expect(document.querySelector(".rv-decide-note")).toHaveTextContent("Realm can't post to TikTok yet.");
  });
});

describe("the kill switch", () => {
  it("holds every post of the team from the head of its Review, and says so until it is let go", async () => {
    const t = ticket(0);
    const { api, store } = await mountApproved(approvedBatch([t]));
    // The list's summary says a post could go out, so the switch is offered.
    store.setState({ teams: { ...store.getState().teams, s1: { ...store.getState().teams["s1"]!, reviews: store.getState().teams["s1"]!.reviews.map((r) => r.id === "v1" ? { ...r, state: "approved", actsTotal: 1, actsDone: 0 } : r) } } });
    fireEvent.click(await screen.findByRole("button", { name: /Hold posting/ }));
    await waitFor(() => expect(api.calls).toContain("teamActsHold:s1:true"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Posting is held."));
    expect(screen.queryByRole("button", { name: /Hold posting/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Post…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Let go" }));
    await waitFor(() => expect(api.calls).toContain("teamActsHold:s1:false"));
  });
});

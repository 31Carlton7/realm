import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ActTicket, TeamReviewDetail, TeamReviewSummary } from "@realm/contracts";
import { ReviewPane } from "./ReviewPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, space, teamReview, teamRole, teamSpace } from "../../state/store.test-fakes";

/**
 * Review: the inbox beside the draft being read, the decision docked under it, and the rows that move
 * as a decision is made. Each test names the one-line mutant it kills.
 */

const realNow = Date.now.bind(Date);
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
/** Past the beat in which a press on a review just put in front is taken as the tail of a double click. */
const settle = () => vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2_000);

const slides = ["deck/01.png", "deck/02.png", "deck/03.png"];
const detail = (id: string, title: string, over: Partial<TeamReviewDetail> = {}): TeamReviewDetail => ({
  ...teamReview(id, "s1", title, { roleId: "r1", roleName: "Content Producer", itemCount: 2, thumb: slides[0]!, channels: ["TikTok"], account: "@versed.nathan", verb: "post", format: "images", recordPath: "creators/nathan.md", createdAt: realNow() - 3_600_000, updatedAt: realNow() }),
  items: [0, 1].map((ord) => ({ id: `${id}-i${ord}`, reviewId: id, version: 1, ord, files: slides, body: `caption ${ord + 1} #ad`,
    target: { channel: "TikTok", account: "@versed.nathan" }, contentHash: "h", approvedHash: null, actState: "none" })),
  previous: [], costUsd: 0.84, durationMs: 360_000, runCapUsd: 3, model: "sonnet", recordName: "Nathan Beyenhof",
  checks: [{ ok: true, title: "Posts as @versed.nathan on TikTok", detail: "managed with consent (contract §4)" }, { ok: null, title: "Realm does not post yet", detail: "Post it by hand." }],
  ledger: [{ ts: 1, glyph: "note", text: "Read Nathan Beyenhof", detail: "creators/nathan.md" }, { ts: 2, glyph: "inbox", text: "Sent 2 items to Review", detail: "Content Producer, sonnet, $0.84 of its $3 run cap" }],
  root: "/spaces/versed", tickets: [], why: "His Sunday sermon did well, so each opens on a question from it.", ...over,
});
const email = (id: string, title: string, over: Partial<TeamReviewDetail> = {}): TeamReviewDetail => detail(id, title, {
  kind: "replies", itemCount: 1, thumb: null, channels: [], verb: "send", format: "email", roleId: "r2", roleName: "Outreach", account: "me@versed.app", to: "dana@acme.com",
  recordPath: null, recordName: null, why: null, createdAt: realNow() - 7_200_000,
  items: [{ id: `${id}-i0`, reviewId: id, version: 1, ord: 0, files: [], body: "Hi Dana, the 14th.", target: null, contentHash: "h", approvedHash: null, actState: "none",
    meta: { Subject: "Pilot" }, action: { connector: "mcp:gmail", verb: "send", account: "me@versed.app", to: "dana@acme.com" } }],
  checks: [{ ok: null, title: "Realm does not send this yet", detail: "Approving marks it ready; do it yourself for now." }], ...over,
});
const summaryOf = ({ items: _i, previous: _p, costUsd: _c, durationMs: _d, runCapUsd: _r, model: _m, recordName: _n, checks: _k, ledger: _l, root: _o, tickets: _t, fileTexts: _f, why: _w, ...s }: TeamReviewDetail): TeamReviewSummary => s;

async function mount(reviews: TeamReviewDetail[] = [detail("v1", "3 slideshows for Nathan"), email("v2", "Reply to Dana")], o: { roles?: ReturnType<typeof teamRole>[]; select?: string } = {}) {
  const roles = o.roles ?? [teamRole("r1", "s1", "Content Producer"), teamRole("r2", "s1", "Outreach")];
  const api = fakeApi({
    profiles: [profile("p1", "Work")],
    spaces: [space("s1", "p1", "Versed")],
    items: { s1: [item("i-review", "s1", { kind: "review", refId: "s1", title: "Review" })] },
    teams: [teamSpace("s1", roles, reviews.map(summaryOf))],
    teamReviews: Object.fromEntries(reviews.map((r) => [r.id, r])),
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  if (o.select) store.getState().selectTeamReview("s1", o.select);
  const it = store.getState().items.find((i) => i.kind === "review")!;
  render(<StoreContext.Provider value={store}><ReviewPane item={it} visible /></StoreContext.Provider>);
  if (reviews.length > 0) await screen.findByRole("heading", { level: 1 });
  return { api, store };
}

const groups = () => [...document.querySelectorAll(".rv-group")].map((g) => [g.querySelector(".rv-group-label")!.textContent, [...g.querySelectorAll("[data-review]")].map((r) => r.getAttribute("data-review"))]);
const dockNote = () => document.querySelector(".rv-dock-note")!.textContent;
const reading = () => document.querySelector(".rv-title")!.textContent;

describe("the inbox", () => {
  it("puts what waits for you first, then what is under way, then the week's decisions — newest first in each", async () => {
    const now = realNow();
    await mount([
      detail("v1", "3 slideshows for Nathan", { createdAt: now - 3_600_000 }),
      email("v2", "Reply to Dana", { createdAt: now - 60_000 }),
      email("v3", "Weekly check-in", { state: "rejected", note: "Too salesy.", decidedAt: now - 120_000 }),
      detail("v4", "Next week's two", { state: "approved", actsTotal: 2, actsWaiting: 0, actsDone: 0, nextActAt: now + 3_600_000, decidedAt: now - 60_000 }),
      detail("v5", "Sunday recap", { state: "changes", note: "Shorter", decidedAt: now - 30_000 }),
    ]);
    // THE MUTANT: the groups in the server's order — a rejected batch above one still waiting.
    expect(groups()).toEqual([["Waiting for you", ["v2", "v1"]], ["In progress", ["v5", "v4"]], ["Recent", ["v3"]]]);
  });

  it("says who made each and what it is and where it goes — the group already says it waits", async () => {
    await mount();
    const line = (id: string) => document.querySelector(`[data-review="${id}"] .rv-row-line`)!.textContent;
    // THE MUTANT: the role's free label ("replies") printed where the format names the thing.
    expect(line("v2")).toBe("OutreachEmail to dana@acme.com");
    expect(line("v1")).toBe("Content Producer2 slideshows on TikTok as @versed.nathan");
    expect(document.querySelector('[data-review="v1"]')).toHaveAccessibleName(/^3 slideshows for Nathan, Content Producer, 2 slideshows on TikTok as @versed\.nathan, \S+$/);
  });

  it("walks the rows with the arrow keys, the row under the keyboard the one being read", async () => {
    const { store } = await mount();
    const first = document.querySelector<HTMLElement>('[data-review="v1"]')!;
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("tabindex", "0");
    first.focus();
    // THE MUTANT: the rows as a column of buttons the keyboard has to Tab through one by one.
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(store.getState().teamReviewSelected["s1"]).toBe("v2"));
    await waitFor(() => expect(reading()).toBe("Reply to Dana"));
    expect(document.activeElement).toBe(document.querySelector('[data-review="v2"]'));
  });

  it("opens a row into the pane, and All reviews goes back — what a side panel's width shows one at a time", async () => {
    await mount();
    expect(document.querySelector(".rv")).not.toHaveAttribute("data-reading");
    fireEvent.click(document.querySelector('[data-review="v1"]')!);
    // THE MUTANT: no reading mark — a narrow pane would show the inbox and never the draft.
    expect(document.querySelector(".rv")).toHaveAttribute("data-reading");
    fireEvent.click(screen.getByRole("button", { name: "All reviews" }));
    expect(document.querySelector(".rv")).not.toHaveAttribute("data-reading");
  });

  it("lands on the review it was opened on from elsewhere — a chat's Open in Review — read, not listed", async () => {
    const { store } = await mount(undefined, { select: "v2" });
    expect(reading()).toBe("Reply to Dana");
    // THE MUTANT: the reading mark only from a row's click — a side panel opened on a draft shows the inbox.
    expect(document.querySelector(".rv")).toHaveAttribute("data-reading");
    fireEvent.click(screen.getByRole("button", { name: "All reviews" }));
    // Opened again on another review while the pane is up: it goes to that one.
    store.getState().selectTeamReview("s1", "v1");
    await waitFor(() => expect(reading()).toBe("3 slideshows for Nathan"));
    expect(document.querySelector(".rv")).toHaveAttribute("data-reading");
  });

  it("names what a role's own close did — replaced, not just put away", async () => {
    await mount([detail("v1", "Hook test", { state: "dismissed", closedAs: "superseded", note: "The new hooks replace these.", decidedAt: realNow() })]);
    expect(document.querySelector('[data-review="v1"] .rv-row-line')).toHaveTextContent("Replaced by a newer version");
    expect(document.querySelector(".rv-pill")).toHaveTextContent("Replaced");
    expect(dockNote()).toBe("Content Producer replaced it with a newer version: “The new hooks replace these.”");
  });

  it("with nothing to review, says who could send something and when the next one runs", async () => {
    const next = new Date(); next.setDate(next.getDate() + 1); next.setHours(9, 0, 0, 0);
    await mount([], { roles: [teamRole("r1", "s1", "Content Producer", { cron: "0 9 * * *", scheduleEnabled: true, nextRunAt: next.getTime() }), teamRole("r2", "s1", "Outreach")] });
    expect(screen.getByRole("heading", { name: "Nothing to review" })).toBeInTheDocument();
    expect(document.querySelectorAll(".rv-empty-mate")).toHaveLength(2);
    // THE MUTANT: a blank pane — the empty state said nothing a person could act on.
    expect(document.querySelector(".rv-empty-next")).toHaveTextContent(/^Content Producer: next run \w{3} 9:00\sAM\.$/);
  });
});

describe("the reader", () => {
  it("reads the draft under its state, its record, its role and what the run cost — and the role's note above the work", async () => {
    await mount(undefined, { select: "v1" });
    expect(document.querySelector(".rv-pill")).toHaveTextContent("Waiting for you");
    expect(document.querySelector(".rv-head-for")).toHaveTextContent("For Nathan Beyenhof");
    const byline = document.querySelector(".rv-byline")!;
    expect(byline).toHaveTextContent("Content Producer");
    // THE MUTANT: a byline without the run's cost — every run shows its dollars (the Teams plan, 9.5).
    expect(byline).toHaveTextContent("$0.84 · 6m");
    expect(document.querySelector(".rv-why")).toHaveTextContent("Why Content Producer made itHis Sunday sermon did well, so each opens on a question from it.");
    // A post drawn as its platform lays it out: the account, the slides, the caption.
    expect(document.querySelector(".rv-post-head")).toHaveTextContent("@versed.nathanTikTok");
    expect(document.querySelectorAll(".rv-post .rv-slide")).toHaveLength(3);
    expect(document.querySelector(".rv-post-caption")).toHaveTextContent("caption 1 #ad");
  });

  it("marks the draft itself as selectable, and the chrome around it not", async () => {
    await mount(undefined, { select: "v2" });
    // THE MUTANT: the attribute dropped — app chrome is unselectable by default, and so would the email be.
    expect(document.querySelector(".rv-mail-body")).toHaveAttribute("data-selectable");
    expect(document.querySelector(".rv-mail-subject")).toHaveAttribute("data-selectable");
    expect(document.querySelector(".rv-row")!.closest("[data-selectable]")).toBeNull();
  });

  it("keeps the decision outside the scroller, so it never dissolves with the slides", async () => {
    await mount(undefined, { select: "v1" });
    const dock = document.querySelector(".rv-dock")!;
    // THE MUTANT: the dock moved inside `.rv-detail-scroll`, where the mask takes it.
    expect(dock.closest(".rv-detail-scroll")).toBeNull();
    expect(dock.closest(".rv-detail")).not.toBeNull();
    expect(within(dock as HTMLElement).getByRole("button", { name: /Approve all 2/ })).toBeEnabled();
  });

  it("says before Approve what it will do — posts nothing, each waits for its press — and that an email is the person's to send", async () => {
    await mount(undefined, { select: "v1" });
    // THE MUTANT: a consequence that promised the yes posts.
    expect(dockNote()).toBe("Approving posts nothing. Each of the 2 posts then waits for you to press Post, on TikTok as @versed.nathan.");
    fireEvent.click(document.querySelector('[data-review="v2"]')!);
    await waitFor(() => expect(reading()).toBe("Reply to Dana"));
    expect(dockNote()).toBe("Approving marks it ready. Realm doesn't send this — you send it yourself from me@versed.app.");
    expect(screen.getByRole("heading", { name: "Before it can send" })).toBeInTheDocument();
  });
});

describe("deciding", () => {
  it("approves with one press: the decide RPC, a receipt, the row out of Waiting for you, and the next one in front", async () => {
    const { api, store } = await mount(undefined, { select: "v2" });
    settle();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.calls).toContain("teamReviewDecide:v2:approve"));
    // THE MUTANT: a toast-less yes — the row leaves and nothing says what became of it.
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toContain("Approved “Reply to Dana”."));
    // It folds away where it stood and rises into the group it joins — the ghost inert, out of the
    // accessibility tree. THE MUTANT: no ghost — the row blinks out, which reads as a lost draft.
    await waitFor(() => expect(document.querySelector('.rv-group[data-group="underway"] [data-review="v2"]')).toHaveAttribute("data-arrived"));
    const ghost = document.querySelector('.rv-group[data-group="waiting"] [data-leaving]');
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost).toHaveTextContent("Reply to Dana");
    // Approved, an email Realm doesn't send is the person's to send now: under way, not waiting.
    await waitFor(() => expect(groups()).toEqual([["Waiting for you", ["v1"]], ["In progress", ["v2"]]]));
    await waitFor(() => expect(document.querySelector("[data-leaving]")).toBeNull());
    // THE MUTANT: the reader left on the decided one — the next waiting draft is what a person reads next.
    await waitFor(() => expect(reading()).toBe("3 slideshows for Nathan"));
  });

  it("leaves a press that lands just as a review is put in front on nothing — the tail of a double click", async () => {
    const { api } = await mount(undefined, { select: "v2" });
    // THE MUTANT: no settle guard — the second click of a double click approves the next draft unread.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(api.calls.some((c) => c.startsWith("teamReviewDecide"))).toBe(false);
  });

  it("sends back with the person's words, from a field in the dock addressed to the role", async () => {
    const { api, store } = await mount(undefined, { select: "v1" });
    fireEvent.click(screen.getByRole("button", { name: /Send back/ }));
    const field = screen.getByRole("textbox", { name: "What should change in 3 slideshows for Nathan?" });
    expect(field).toHaveAttribute("placeholder", "What should Content Producer change?");
    expect(document.activeElement).toBe(field);
    // THE MUTANT: Send back sending with no words.
    expect(screen.getByRole("button", { name: "Send back to Content Producer" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "Shorter hook" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.calls).toContain("teamReviewRequestChanges:v1:Shorter hook"));
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toContain("Sent “3 slideshows for Nathan” back to Content Producer."));
    await waitFor(() => expect(groups()).toEqual([["Waiting for you", ["v2"]], ["In progress", ["v1"]]]));
  });

  it("puts the field away on Escape and leaves the draft as it was", async () => {
    const { api } = await mount(undefined, { select: "v1" });
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: /Why reject/ }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.calls.some((c) => c.startsWith("teamReviewReject"))).toBe(false);
  });

  it("rejects with a reason the role is told, or without one — the reason is optional, not a gate", async () => {
    const { api, store } = await mount(undefined, { select: "v1" });
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    const field = screen.getByRole("textbox", { name: /Why reject 3 slideshows for Nathan/ });
    expect(field).toHaveAttribute("placeholder", "Why not? Content Producer is told (optional)");
    // THE MUTANT: the Reject button disabled until something is typed, like Send back's.
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    fireEvent.change(field, { target: { value: "Off brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject and tell Content Producer" }));
    await waitFor(() => expect(api.calls).toContain("teamReviewReject:v1:Off brand"));
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toContain("Rejected “3 slideshows for Nathan”. Content Producer is told why."));
    await waitFor(() => expect(groups()).toEqual([["Waiting for you", ["v2"]], ["Recent", ["v1"]]]));
  });

  it("closes an approved batch that has not all gone out, saying first what it takes back and what it cannot", async () => {
    const { api } = await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([
      ticket(0, { state: "scheduled", pressedAt: 1 }), ticket(1), ticket(2, { state: "done", actedAt: realNow(), proofUrl: "https://fake-platform.invalid/1" }),
    ]))]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const ask = document.querySelector(".rv-dock-ask")!;
    // THE MUTANT: Close offered only while the batch waits — after the yes, the moment it matters, no way out.
    expect(ask).toHaveTextContent("Close “3 slideshows for Nathan”? Takes back all 2 not posted yet. 1 already went out and stays out.");
    expect(screen.queryByRole("button", { name: "Don't post" })).toBeNull();
    fireEvent.click(within(document.querySelector(".rv-dock") as HTMLElement).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(api.calls).toContain("teamReviewClose:v1"));
  });
});

/** A ticket for item `ord` of v1, ready for its press — what an approved batch carries. */
const ticket = (ord: number, over: Partial<ActTicket> = {}): ActTicket => ({
  id: `01M07DEZCTCDT8QKVJ9MBTS6W${ord}`, spaceId: "s1", reviewId: "v1", itemId: `v1-i${ord}`, ord, kind: "post", channel: "TikTok",
  account: "@versed.nathan", to: null, device: "Lab iPhone 2", signin: "tiktok.com/nathan", consent: "contract §4", contentHash: "h".repeat(64),
  disclosure: "caption", state: "ready", slotAt: realNow() + 2 * 3_600_000, slotWhy: "next", pressedAt: null, actedAt: null, proofUrl: null,
  screenshot: null, error: null, todayCount: 0, todayCap: 3, adapter: { connected: true, label: "TikTok (fake, for testing)", why: null },
  createdAt: 0, updatedAt: 0, ...over,
});
const approvedBatch = (tickets: ActTicket[]): Partial<TeamReviewDetail> => ({
  state: "approved", decidedAt: realNow(), actsTotal: tickets.length, actsDone: tickets.filter((t) => t.state === "done").length,
  actsWaiting: tickets.filter((t) => t.state === "ready" && !t.error).length, actsFailed: tickets.filter((t) => t.state === "ready" && t.error).length, tickets,
});
const sheet = () => screen.getByRole("dialog");

describe("after the yes", () => {
  it("keeps a batch with posts to press in Waiting for you, and Post… opens the sheet that names the consequence", async () => {
    await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([ticket(0), ticket(1)])), email("v2", "Reply to Dana")]);
    // THE MUTANT: an approved batch filed as finished — the post still waiting for its press leaves the inbox.
    expect(groups()[0]).toEqual(["Waiting for you", ["v1", "v2"]]);
    fireEvent.click(document.querySelector('[data-review="v1"]')!);
    await waitFor(() => expect(document.querySelector(".rv-pill")).toHaveTextContent("Ready to post"));
    fireEvent.click(screen.getByRole("button", { name: "Post…" }));
    expect(sheet()).toHaveAccessibleName("Post slideshow 1 to TikTok?");
    expect(sheet()).toHaveTextContent("Realm posts it from Lab iPhone 2, signed in as Nathan Beyenhof's managed account. It cannot be taken back from Realm; delete it on TikTok.");
    expect(within(sheet()).getByRole("button", { name: /^Post at \d{1,2}:\d{2}\s?[AP]M$/ })).toBeEnabled();
  });

  it("is out of an agent's reach: the sheet, its button and the Post… that opens it are all data-no-agent", async () => {
    await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([ticket(0)]))]);
    const open = screen.getByRole("button", { name: "Post…" });
    // THE MUTANT: the attribute dropped from the sheet — `app_act` would press "Post at …" for the agent.
    expect(open.closest("[data-no-agent]")).not.toBeNull();
    fireEvent.click(open);
    expect(within(sheet()).getByRole("button", { name: /^Post at/ }).closest("[data-no-agent]")).not.toBeNull();
    expect(sheet().querySelector(".ps")!.closest("[data-no-agent]")).not.toBeNull();
  });

  it("one click presses main first, then asks the server to act on that press — for exactly the time it showed", async () => {
    const t = ticket(0);
    const { api, store } = await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([t]))]);
    fireEvent.click(screen.getByRole("button", { name: "Post…" }));
    fireEvent.click(within(sheet()).getByRole("button", { name: /^Post at/ }));
    await waitFor(() => expect(api.calls).toContain(`teamTicketPost:${t.id}`));
    const press = api.calls.indexOf(`teamTicketPress:${t.id}:${t.slotAt}:false`);
    // THE MUTANT: the server asked without the press (or before it) — refused every time.
    expect(press).toBeGreaterThan(-1);
    expect(press).toBeLessThan(api.calls.indexOf(`teamTicketPost:${t.id}`));
    // THE MUTANT: a press with no receipt — the sheet closes and nothing says when it goes.
    await waitFor(() => expect(store.getState().toasts.map((x) => x.text)).toContainEqual(expect.stringMatching(/^Set for \d{1,2}:\d{2}\s?[AP]M (today|tomorrow)\. You can take it back until then\.$/)));
  });

  it("will not post a caption with no #ad until the platform's paid-partnership label is ticked", async () => {
    const t = ticket(0, { disclosure: null });
    const { api } = await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([t]))]);
    fireEvent.click(screen.getByRole("button", { name: "Post…" }));
    const button = within(sheet()).getByRole("button", { name: /^Post at/ });
    // THE MUTANT: the button live with nothing disclosing the partnership.
    expect(button).toBeDisabled();
    fireEvent.click(within(sheet()).getByRole("checkbox", { name: /paid-partnership label/ }));
    fireEvent.click(button);
    await waitFor(() => expect(api.calls).toContain(`teamTicketPress:${t.id}:${t.slotAt}:true`));
  });

  it("says a refused post didn't go out and why, in the dock, and offers the press again", async () => {
    await mount([detail("v1", "Sunday recap", approvedBatch([ticket(0, { error: "Instagram asked to confirm the sign-in.", screenshot: "/home/proof/1.png" })]))]);
    expect(document.querySelector('[data-review="v1"]')).toHaveAttribute("data-tone", "bad");
    expect(document.querySelector(".rv-pill")).toHaveTextContent("Didn't post");
    // THE MUTANT: a failed act read as one simply waiting — "Not posted yet" with no word of why.
    expect(dockNote()).toBe("Didn't go out: Instagram asked to confirm the sign-in.");
    expect(document.querySelector(".rv-dock-note")).toHaveAttribute("data-tone", "bad");
    expect(screen.getByRole("button", { name: "Post again…" })).toBeEnabled();
    // Approved, the checks are what Realm found, not a gate still ahead.
    expect(screen.getByRole("heading", { name: "What Realm checked" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeInTheDocument();
  });

  it("a pressed post says when it goes and can be taken back; one that went out keeps its proof", async () => {
    await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([ticket(0, { state: "scheduled", pressedAt: 1 }),
      ticket(1, { state: "done", actedAt: realNow(), proofUrl: "https://fake-platform.invalid/tiktok/x/1", screenshot: "/home/team-proof/s1/1.png" })]))]);
    expect(dockNote()).toMatch(/^Posts .+ today\. You can take it back until then\.$/);
    expect(screen.getByRole("button", { name: "Don't post" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "2" }));
    expect(dockNote()).toMatch(/^Posted at .+ as @versed\.nathan\.$/);
    expect(screen.getByRole("link", { name: "Open post" })).toHaveAttribute("href", "https://fake-platform.invalid/tiktok/x/1");
  });

  it("where the platform is not connected, offers no Post… and keeps the by-hand path, saying why", async () => {
    await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([ticket(0, { adapter: { connected: false, label: "TikTok", why: "Realm can't post to TikTok yet." } })]))]);
    // THE MUTANT: a Post… that can only ever be refused (design.md: offer a capability only where it exists).
    expect(screen.queryByRole("button", { name: "Post…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as posted" })).toBeInTheDocument();
    expect(dockNote()).toContain("Realm can't post to TikTok yet.");
  });
});

describe("the kill switch", () => {
  it("holds every post of the team from the head of its Review, and says so until it is let go", async () => {
    const { api } = await mount([detail("v1", "3 slideshows for Nathan", approvedBatch([ticket(0)]))]);
    fireEvent.click(await screen.findByRole("button", { name: /Hold posting/ }));
    await waitFor(() => expect(api.calls).toContain("teamActsHold:s1:true"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Posting is held for this team."));
    // THE MUTANT: Post… live while the team is held.
    expect(screen.getByRole("button", { name: "Post…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Let go" }));
    await waitFor(() => expect(api.calls).toContain("teamActsHold:s1:false"));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamReviewDetail } from "@realm/contracts";
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

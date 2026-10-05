import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type GhStatus, type PrDetail, type PrPage, type PrReview, type PrSummary } from "@realm/contracts";

/** The page's calls, answered from what each test sets, and every one kept. Nothing reaches a socket
 *  — and so nothing reaches gh, or GitHub. */
const calls: { method: string; params: any }[] = [];
let status: GhStatus = { state: "ready", login: "carlton", reason: null };
let pages: Record<string, PrPage[]> = {};
let detail: PrDetail;
let review: PrReview | null = null;
let instructions = "";
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      switch (method) {
        case "codeReview.status": return status;
        case "codeReview.list": return pages[params.section]![params.cursor ? 1 : 0] ?? { prs: [], nextCursor: null, total: 0 };
        case "codeReview.search": return { prs: [ROW], nextCursor: null, total: 1 };
        case "codeReview.detail": return detail;
        case "codeReview.reviewGet": return { review };
        case "codeReview.pins": return { pins: [] };
        case "codeReview.places": return { places: [{ spaceId: "s1", projectId: null, name: "Versed", path: "/tmp/versed", repo: null, branch: null }] };
        case "codeReview.thread": return { sessionId: null, spaceId: null };
        case "codeReview.instructions": return { text: instructions };
        case "codeReview.setInstructions": instructions = params.text; return { text: params.text };
        case "codeReview.review": return { ...REVIEW, state: "running", findings: [], summary: "" };
        case "codeReview.submit": return { id: 7, url: "https://github.com/acme/widgets/pull/42#pullrequestreview-7" };
        case "terminals.create": return { terminalId: "01HQ00000000000000000000T1", itemId: "i-term" };
        case "terminals.prefill": return { ok: true };
        default: throw new Error(`unexpected ${method}`);
      }
    },
  }),
}));

import { CodeReviewPage } from "./CodeReviewPage";
import { forgetHeld } from "./held";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

const ref = { owner: "acme", repo: "widgets", number: 42 };
const T = Date.UTC(2026, 9, 3);
const row = (n: number, title = `Change ${n}`): PrSummary => ({ ref: { ...ref, number: n }, title, url: `https://github.com/acme/widgets/pull/${n}`,
  state: "open", draft: false, author: "mara", createdAt: T, updatedAt: T });
const ROW = row(42, "Stream the tokenizer");
const DETAIL: PrDetail = {
  ...ROW, body: "## Why\n\nSpeed.", base: "main", head: "mara/stream", headOwner: null, headSha: "abc1234def",
  additions: 3, deletions: 1, changedFiles: 1, mergeable: "mergeable", mergeState: "blocked", decision: "review_required",
  reviewers: [{ name: "carlton", team: false, state: "pending" }], comments: { total: 1, recent: [{ author: "jo", body: "Why not a stream?", createdAt: T, url: null }] },
  checks: [{ name: "test", state: "success", url: null }, { name: "lint", state: "failure", url: null }],
};
const REVIEW: PrReview = {
  ref, headSha: "abc1234def", sessionId: "01HQ000000000000000000SES1", spaceId: "s1", agentKind: "claude", model: null, state: "done",
  summary: "Mostly right.", startedAt: T, finishedAt: T,
  findings: [{ id: "f1", path: "src/a.ts", line: 14, side: "RIGHT", body: "Carry the partial token.", anchored: true }],
};

beforeEach(() => {
  forgetHeld();
  calls.length = 0;
  status = { state: "ready", login: "carlton", reason: null };
  pages = {
    authored: [{ prs: [row(39, "Add a --json flag")], nextCursor: null, total: 1 }],
    review: [{ prs: [ROW, row(41)], nextCursor: "o2", total: 3 }, { prs: [row(40, "Pin the base image")], nextCursor: null, total: 3 }],
    team: [{ prs: [row(50, "Split the billing service")], nextCursor: null, total: 1 }],
  };
  detail = DETAIL;
  review = null;
  instructions = "";
});
afterEach(() => cleanup());

async function mount() {
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  render(<StoreContext.Provider value={store}>
    <CodeReviewPage item={item("cr", "s1", { kind: "code-review-page", title: "Code review", refId: PAGE_REF_IDS["code-review-page"] })} visible />
  </StoreContext.Provider>);
  return { store };
}
const called = (method: string) => calls.filter((c) => c.method === method);
const openRequest = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^Stream the tokenizer/ }));
  return screen.findByRole("heading", { level: 2, name: "Stream the tokenizer" });
};

describe("setting up", () => {
  it("says gh is signed out, and Set up GitHub types `gh auth login` into a new terminal without running it", async () => {
    status = { state: "signed-out", login: null, reason: null };
    const { store } = await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Set up GitHub" }));
    await waitFor(() => expect(called("terminals.prefill")).toHaveLength(1));
    expect(called("terminals.create")[0]!.params).toEqual({ spaceId: "s1" });
    // THE MUTANT: a newline on the end — Realm would be running the sign-in, not offering it.
    expect(called("terminals.prefill")[0]!.params).toEqual({ terminalId: "01HQ00000000000000000000T1", command: "gh auth login" });
    expect(called("codeReview.list")).toHaveLength(0);
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
  });

  it("offers the install and the sign-in as one command where gh is missing", async () => {
    status = { state: "missing", login: null, reason: null };
    await mount();
    expect(await screen.findByText(/which is not on this Mac yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up GitHub" }));
    await waitFor(() => expect(called("terminals.prefill")[0]?.params.command).toBe("brew install gh && gh auth login"));
  });

  it("does not send a person offline to sign in again", async () => {
    status = { state: "unreachable", login: null, reason: "error connecting to api.github.com" };
    await mount();
    expect(await screen.findByText("GitHub did not answer: error connecting to api.github.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up GitHub" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(called("codeReview.status").some((c) => c.params.force)).toBe(true));
  });
});

describe("the column", () => {
  it("lists what I opened and what waits on me, folds the team's list until opened, and pages on Show more", async () => {
    await mount();
    const col = await screen.findByRole("navigation", { name: "Pull requests" });
    expect(await within(col).findByRole("button", { name: /^Add a --json flag/ })).toBeInTheDocument();
    expect(within(col).getByRole("button", { name: /^Stream the tokenizer/ })).toBeInTheDocument();
    // THE MUTANT: the team's list asked for with the rest — a request the folded list never needed.
    expect(called("codeReview.list").map((c) => c.params.section).sort()).toEqual(["authored", "review"]);
    fireEvent.click(within(col).getByRole("button", { name: "Show more" }));
    expect(await within(col).findByRole("button", { name: /^Pin the base image/ })).toBeInTheDocument();
    expect(called("codeReview.list").at(-1)!.params).toMatchObject({ section: "review", cursor: "o2" });
    fireEvent.click(within(col).getByRole("button", { name: "Needs my team's review" }));
    expect(await within(col).findByRole("button", { name: /^Split the billing service/ })).toBeInTheDocument();
  });

  it("opens a pasted link as the request it names, without searching for it", async () => {
    await mount();
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search or paste a pull request link" }), { target: { value: "https://github.com/acme/widgets/pull/42/files" } });
    fireEvent.click(await screen.findByRole("button", { name: "Open acme/widgets#42" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Stream the tokenizer" })).toBeInTheDocument();
    expect(called("codeReview.detail")[0]!.params.ref).toEqual(ref);
    expect(called("codeReview.search")).toHaveLength(0);
  });
});

describe("a request", () => {
  it("reads its state, branches, merge status, conversation, reviewers and checks", async () => {
    await mount();
    await openRequest();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("mara/stream")).toBeInTheDocument();
    expect(screen.getByText("Blocked until it has an approving review")).toBeInTheDocument();
    expect(screen.getByText("Why not a stream?")).toBeInTheDocument();
    expect(screen.getByText("1 failed · 1 passed")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Changes/ }).closest("label")!.textContent).toContain("+3 −1");
  });
});

describe("Submit review — the one write", () => {
  const openSubmit = async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Submit review/ }));
    return screen.findByRole("dialog", { name: "Submit review" });
  };

  it("posts exactly the review composed, only on Submit, and never with an empty comment", async () => {
    await mount();
    await openRequest();
    const sheet = await openSubmit();
    const submit = within(sheet).getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("radio", { name: /Approve/ }));
    fireEvent.change(within(sheet).getByRole("textbox", { name: /Review comment/ }), { target: { value: "Looks right to me." } });
    // What will be posted, said beside the button before it is pressed.
    expect(within(sheet).getByText("Posts an approval to acme/widgets#42 as @carlton.")).toBeInTheDocument();
    expect(called("codeReview.submit")).toHaveLength(0);
    fireEvent.click(submit);
    await waitFor(() => expect(called("codeReview.submit")).toHaveLength(1));
    expect(called("codeReview.submit")[0]!.params).toEqual({ ref, headSha: "abc1234def", event: "APPROVE", body: "Looks right to me.", comments: [] });
  });

  it("carries a kept finding as a line comment on its side, and lists it before posting", async () => {
    review = REVIEW;
    await mount();
    await openRequest();
    fireEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    expect(screen.getByText("In your review")).toBeInTheDocument();
    const sheet = await openSubmit();
    expect(within(sheet).getByRole("list", { name: "Line comments in this review" }).textContent).toContain("src/a.ts:14");
    fireEvent.change(within(sheet).getByRole("textbox", { name: /Review comment/ }), { target: { value: "One thing." } });
    expect(within(sheet).getByText("Posts a comment with 1 line comment to acme/widgets#42 as @carlton.")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(called("codeReview.submit")).toHaveLength(1));
    expect(called("codeReview.submit")[0]!.params.comments).toEqual([{ path: "src/a.ts", line: 14, side: "RIGHT", body: "Carry the partial token." }]);
  });

  it("offers the author only a comment on their own request", async () => {
    detail = { ...DETAIL, author: "Carlton" };
    await mount();
    await openRequest();
    const sheet = await openSubmit();
    expect(within(sheet).getByRole("radio", { name: /Approve/ })).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: /Request changes/ })).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: /Comment/ })).toBeChecked();
  });
});

describe("Review with…", () => {
  it("runs a read-only reviewer on the picked model, in the place questions go, and posts nothing", async () => {
    await mount();
    await openRequest();
    fireEvent.click(screen.getByRole("button", { name: "Review with Fable 5.1" }));
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.review")[0]!.params).toEqual({ ref, profileId: "p1", spaceId: "s1", projectId: null, agentKind: "claude", model: null });
    expect(await screen.findByRole("button", { name: "Reviewing…" })).toBeDisabled();
    expect(called("codeReview.submit")).toHaveLength(0);
  });

  it("keeps the profile's instructions from the gear, with an example a press away, and Save and run runs", async () => {
    instructions = "Skip style nits.";
    await mount();
    await openRequest();
    fireEvent.click(screen.getByRole("button", { name: "Review instructions" }));
    const sheet = await screen.findByRole("dialog", { name: "Review instructions" });
    const field = within(sheet).getByRole("textbox", { name: "Review instructions" });
    await waitFor(() => expect(field).toHaveValue("Skip style nits."));
    fireEvent.click(within(sheet).getByRole("button", { name: "Add example" }));
    expect(field).toHaveValue("Skip style nits.\nI care most about the data model. Tell me where we might be overcomplicating things.");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: "Save and run" })); });
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.setInstructions")[0]!.params).toEqual({ profileId: "p1", text: "Skip style nits.\nI care most about the data model. Tell me where we might be overcomplicating things." });
  });
});

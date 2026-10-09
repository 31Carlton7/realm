import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MODEL_EFFORTS_KEY, PAGE_REF_IDS, type FileDiff, type GhStatus, type PrDetail, type PrFiles, type PrPage, type PrReview, type PrSummary, type ReviewerPick } from "@realm/contracts";

/** The page's calls, answered from what each test sets, and every one kept. Nothing reaches a socket
 *  — and so nothing reaches gh, or GitHub. */
const calls: { method: string; params: any }[] = [];
let status: GhStatus = { state: "ready", login: "carlton", reason: null };
let accounts: string[] = ["carlton"];
/** Set, gh's answer about who is signed in waits on it — the moment a page has asked and not heard. */
let statusGate: Promise<void> | null = null;
/** Set, each question about who is signed in is answered by it, by the order it was asked in — for
 *  answers that come back in another order than their questions went out. */
let statusFor: ((asked: number) => Promise<GhStatus>) | null = null;
/** What the page listens for from the server, and `tell` to say it. */
const heard = new Map<string, Set<(payload: any) => void>>();
const tell = (event: string, payload: unknown) => { for (const fn of [...(heard.get(event) ?? [])]) fn(payload); };
let pages: Record<string, PrPage[]> = {};
let detail: PrDetail;
let review: PrReview | null = null;
let instructions = "";
let reviewerPick: ReviewerPick | null = null;
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, fn: (payload: any) => void) => {
      if (!heard.has(event)) heard.set(event, new Set());
      heard.get(event)!.add(fn);
      return () => { heard.get(event)?.delete(fn); };
    },
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      switch (method) {
        case "codeReview.status":
          if (statusFor) return statusFor(calls.filter((c) => c.method === "codeReview.status").length);
          if (statusGate) await statusGate;
          return status;
        case "codeReview.accounts": return { accounts, active: accounts[0] ?? null };
        case "codeReview.setAccount": status = { state: "ready", login: params.login, reason: null, account: params.login }; return status;
        case "codeReview.list": return pages[params.section]![params.cursor ? 1 : 0] ?? { prs: [], nextCursor: null, total: 0 };
        case "codeReview.search": return { prs: [ROW], nextCursor: null, total: 1 };
        case "codeReview.detail": return detail;
        case "codeReview.files": return FILES;
        case "codeReview.patches": return { patches: [PATCH] };
        case "codeReview.reviewGet": return { review };
        case "codeReview.pins": return { pins: [] };
        case "codeReview.places": return { places: [{ spaceId: "s1", projectId: null, name: "Versed", path: "/tmp/versed", repo: null, branch: null }] };
        case "codeReview.thread": return { sessionId: null, spaceId: null };
        case "codeReview.ask": return { sessionId: "01HQ000000000000000000ASK1", itemId: null };
        case "codeReview.instructions": return { text: instructions };
        case "codeReview.setInstructions": instructions = params.text; return { text: params.text };
        case "codeReview.reviewerPick": return { pick: reviewerPick };
        case "codeReview.setReviewerPick": reviewerPick = params.pick; return params.pick;
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
import { forgetHeld, signInSent } from "./held";
import { exited } from "../../components/popover-exit.test-fakes";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, space, type FakeData } from "../../state/store.test-fakes";
/* The overlay draws its page through the registry, which the panes fill by side effect. */
import "../index";
import { PageNavProvider } from "../../components/page-nav";
import { PageOverlay } from "../../components/PageOverlay";
import { Sidebar } from "../../components/sidebar/Sidebar";

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
  ref, headSha: "abc1234def", sessionId: "01HQ000000000000000000SES1", spaceId: "s1", agentKind: "claude", model: null, effort: null, state: "done",
  summary: "Mostly right.", startedAt: T, finishedAt: T,
  findings: [{ id: "f1", path: "src/a.ts", line: 14, side: "RIGHT", body: "Carry the partial token.", anchored: true }],
};
/** The request's one changed file, with the line the finding above is on. */
const FILES: PrFiles = { headSha: "abc1234def", total: 1, truncated: false,
  files: [{ path: "src/a.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, patch: "text" }] };
const PATCH: FileDiff = { path: "src/a.ts", oldPath: null, staged: false, binary: false, truncated: false, truncatedReason: null, additions: 1, deletions: 0,
  hunks: [{ header: "", oldStart: 13, oldLines: 2, newStart: 13, newLines: 3, lines: [
    { kind: "context", text: "  feed(chunk: string) {", oldLine: 13, newLine: 13 },
    { kind: "add", text: "    this.partial += chunk;", oldLine: null, newLine: 14 },
    { kind: "context", text: "  }", oldLine: 14, newLine: 15 },
  ] }] };

beforeEach(() => {
  forgetHeld();
  calls.length = 0;
  status = { state: "ready", login: "carlton", reason: null };
  accounts = ["carlton"];
  statusGate = null;
  statusFor = null;
  heard.clear();
  pages = {
    authored: [{ prs: [row(39, "Add a --json flag")], nextCursor: null, total: 1 }],
    review: [{ prs: [ROW, row(41)], nextCursor: "o2", total: 3 }, { prs: [row(40, "Pin the base image")], nextCursor: null, total: 3 }],
    team: [{ prs: [row(50, "Split the billing service")], nextCursor: null, total: 1 }],
  };
  detail = DETAIL;
  review = null;
  instructions = "";
  reviewerPick = null;
});
afterEach(() => cleanup());

async function mount(data: FakeData = {}) {
  const store = createAppStore(fakeApi(data));
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

describe("the account a profile reviews as", () => {
  const openOptions = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Code review options" }));
    return screen.findByRole("menu", { name: "Code review options" });
  };

  it("names the one account gh is signed in to as it always did, with nothing to pick and nothing sent as anyone", async () => {
    await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    const menu = await openOptions();
    expect(within(menu).getByRole("group", { name: "Signed in to GitHub as @carlton" })).toBeInTheDocument();
    expect(within(menu).queryAllByRole("menuitemcheckbox")).toHaveLength(0);
    expect(called("codeReview.status")[0]!.params).toEqual({ force: false, profileId: "p1" });
    expect(called("codeReview.list").some((c) => "account" in c.params)).toBe(false);
  });

  it("lists gh's accounts with the one in use ticked, and a pick reads the column again as that account", async () => {
    accounts = ["carlton", "mara"];
    const { store } = await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    const menu = await openOptions();
    const group = within(menu).getByRole("group", { name: "GitHub account" });
    expect(within(group).getByRole("menuitemcheckbox", { name: "@carlton" })).toHaveAttribute("aria-checked", "true");
    const other = within(group).getByRole("menuitemcheckbox", { name: "@mara" });
    expect(other).toHaveAttribute("aria-checked", "false");
    expect(other).toHaveAttribute("title", "Read pull requests, post reviews, and open pull requests as @mara in this profile. The account gh uses in a terminal stays the same.");
    calls.length = 0;
    fireEvent.click(other);
    await waitFor(() => expect(called("codeReview.setAccount")).toHaveLength(1));
    expect(called("codeReview.setAccount")[0]!.params).toEqual({ profileId: "p1", login: "mara" });
    await waitFor(() => expect(called("codeReview.list").map((c) => c.params.section).sort()).toEqual(["authored", "review"]));
    expect(called("codeReview.list").every((c) => c.params.account === "mara")).toBe(true);
    expect(store.getState().toasts.map((t) => t.text)).toContain("Code review and pull requests in this profile use @mara");
    const again = await openOptions();
    expect(within(again).getByRole("menuitemcheckbox", { name: "@mara" })).toHaveAttribute("aria-checked", "true");
    expect(within(again).getByRole("menuitemcheckbox", { name: "@carlton" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps a profile on the account gh has active once that account is picked, and reads nothing again for it", async () => {
    accounts = ["carlton", "mara"];
    await mount();
    await openRequest();
    const active = within(await openOptions()).getByRole("menuitemcheckbox", { name: "@carlton" });
    expect(active).toHaveAttribute("title", "This profile reads pull requests, posts reviews, and opens pull requests as @carlton, the account gh has active. To keep this profile on @carlton when that changes, choose it.");
    calls.length = 0;
    fireEvent.click(active);
    await waitFor(() => expect(called("codeReview.setAccount")).toHaveLength(1));
    expect(called("codeReview.setAccount")[0]!.params).toEqual({ profileId: "p1", login: "carlton" });
    await exited();
    expect(screen.getByRole("heading", { level: 2, name: "Stream the tokenizer" })).toBeInTheDocument();
    expect(called("codeReview.list")).toHaveLength(0);
    const kept = within(await openOptions()).getByRole("menuitemcheckbox", { name: "@carlton" });
    expect(kept).toHaveAttribute("title", "This profile reads pull requests, posts reviews, and opens pull requests as @carlton.");
    fireEvent.click(kept);
    await exited();
    expect(called("codeReview.setAccount")).toHaveLength(1);
  });

  it("lets go of the request on screen when the account changes, and keeps the review being written", async () => {
    accounts = ["carlton", "mara"];
    await mount();
    await openRequest();
    fireEvent.click(screen.getByRole("button", { name: /^Submit review/ }));
    fireEvent.change(within(await screen.findByRole("dialog", { name: "Submit review" })).getByRole("textbox", { name: /Review comment/ }), { target: { value: "Half written." } });
    fireEvent.click(within(await openOptions()).getByRole("menuitemcheckbox", { name: "@mara" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Select a pull request" })).toBeInTheDocument();
    calls.length = 0;
    await openRequest();
    expect(called("codeReview.detail")[0]!.params).toMatchObject({ ref, account: "mara" });
    fireEvent.click(screen.getByRole("button", { name: /^Submit review/ }));
    expect(within(await screen.findByRole("dialog", { name: "Submit review" })).getByRole("textbox", { name: /Review comment/ })).toHaveValue("Half written.");
  });

  it("reads, reviews and posts a request as the picked account, and says so beside Submit", async () => {
    accounts = ["carlton", "mara"];
    status = { state: "ready", login: "mara", reason: null, account: "mara" };
    await mount();
    await openRequest();
    expect(called("codeReview.detail")[0]!.params).toMatchObject({ ref, account: "mara" });
    fireEvent.click(screen.getByRole("radio", { name: /Changes/ }));
    await waitFor(() => expect(called("codeReview.patches")).toHaveLength(1));
    expect(called("codeReview.files")[0]!.params).toMatchObject({ account: "mara" });
    expect(called("codeReview.patches")[0]!.params).toMatchObject({ account: "mara" });
    fireEvent.click(screen.getByRole("button", { name: "Review with Fable 5.1" }));
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.review")[0]!.params).toMatchObject({ profileId: "p1", account: "mara" });
    fireEvent.click(screen.getByRole("button", { name: /^Submit review/ }));
    const sheet = await screen.findByRole("dialog", { name: "Submit review" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: /Review comment/ }), { target: { value: "Looks right to me." } });
    expect(within(sheet).getByText("Posts a comment to acme/widgets#42 as @mara.")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(called("codeReview.submit")).toHaveLength(1));
    expect(called("codeReview.submit")[0]!.params).toEqual({ ref, headSha: "abc1234def", event: "COMMENT", body: "Looks right to me.", comments: [], account: "mara" });
  });

  it("asks a question about a request as the picked account", async () => {
    status = { state: "ready", login: "mara", reason: null, account: "mara" };
    await mount();
    await openRequest();
    const box = within(screen.getByRole("region", { name: "Ask about this pull request" })).getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "Is the stream right?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(called("codeReview.ask")).toHaveLength(1));
    expect(called("codeReview.ask")[0]!.params).toMatchObject({ ref, account: "mara" });
  });

  it("asks about another profile's account afresh, rather than drawing that profile as this one", async () => {
    const { store } = await mount({ spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Homework")] });
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    status = { state: "ready", login: "mara", reason: null, account: "mara" };
    pages = { authored: [{ prs: [row(77, "Hers alone")], nextCursor: null, total: 1 }], review: [{ prs: [], nextCursor: null, total: 0 }] };
    calls.length = 0;
    let answer!: () => void;
    statusGate = new Promise<void>((resolve) => { answer = resolve; });
    await act(async () => { await store.getState().selectProfile("p2"); });
    await waitFor(() => expect(called("codeReview.status").map((c) => c.params.profileId)).toContain("p2"));
    expect(screen.queryByRole("button", { name: /^Stream the tokenizer/ })).toBeNull();
    await act(async () => { answer(); });
    expect(await screen.findByRole("button", { name: /^Hers alone/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stream the tokenizer/ })).toBeNull();
    expect(called("codeReview.list").every((c) => c.params.account === "mara")).toBe(true);
  });

  it("asks gh again about who is signed in after sending the person to a terminal to sign in", async () => {
    accounts = ["carlton"];
    const first = await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    fireEvent.click(within(await openOptions()).getByRole("menuitem", { name: /^Sign in again in a terminal/ }));
    await waitFor(() => expect(first.store.getState().pageOverlay).toBeNull());
    cleanup();
    calls.length = 0;
    accounts = ["carlton", "mara"];
    await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    await waitFor(() => expect(called("codeReview.accounts").map((c) => c.params.force)).toEqual([true]));
    expect(called("codeReview.status")[0]!.params).toEqual({ force: true, profileId: "p1" });
    expect(within(await openOptions()).getByRole("menuitemcheckbox", { name: "@mara" })).toBeInTheDocument();
  });

  it("reads gh's accounts again on Refresh", async () => {
    await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    calls.length = 0;
    fireEvent.click(within(await openOptions()).getByRole("menuitem", { name: "Refresh" }));
    await waitFor(() => expect(called("codeReview.accounts").map((c) => c.params.force)).toEqual([true]));
  });
});

describe("whose requests these are, in the column's head", () => {
  const whose = () => document.querySelector("nav.cr-col > .cr-col-head > .cr-col-as");
  const named = () => whose()?.querySelector(".cr-col-as-profile > :first-child")?.textContent ?? null;
  const account = () => whose()?.querySelector(".cr-col-as-login")?.textContent ?? null;
  const said = () => whose()?.querySelector(".visually-hidden")?.textContent ?? null;
  const listed = () => screen.findByRole("button", { name: /^Stream the tokenizer/ });

  it("names the profile and the account its requests are read and reviewed as, after the page's name and before its menu", async () => {
    await mount();
    await listed();
    expect(named()).toBe("Work");
    expect(account()).toBe("@carlton");
    expect(whose()!.previousElementSibling).toBe(screen.getByRole("heading", { level: 1, name: "Code review" }));
    expect(whose()!.nextElementSibling).toBe(screen.getByRole("button", { name: "Code review options" }));
  });

  it("says it in a sentence to a screen reader and on hover, and keeps the name, the dot and the login it draws from being read out as well", async () => {
    await mount();
    await listed();
    expect(said()).toBe("Code review in the Work profile reads and posts as @carlton.");
    expect(whose()).toHaveAttribute("title", "Code review in the Work profile reads and posts as @carlton.");
    expect([...whose()!.children].map((el) => [el.className, el.getAttribute("aria-hidden")])).toEqual([["visually-hidden", null], ["cr-col-as-profile", "true"], ["cr-col-as-login", "true"]]);
    expect([...whose()!.querySelector(".cr-col-as-profile")!.children].map((el) => el.textContent)).toEqual(["Work", "·"]);
  });

  it("names the account alone where there is one profile, with no other to tell it from", async () => {
    await mount({ profiles: [profile("p1", "Work")] });
    await listed();
    expect(named()).toBeNull();
    expect(account()).toBe("@carlton");
    expect(said()).toBe("Code review reads and posts as @carlton.");
    expect(whose()).toHaveAttribute("title", "Code review reads and posts as @carlton.");
  });

  it("follows a pick made from the column's menu", async () => {
    accounts = ["carlton", "mara"];
    await mount();
    await listed();
    fireEvent.click(await screen.findByRole("button", { name: "Code review options" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Code review options" })).getByRole("menuitemcheckbox", { name: "@mara" }));
    await waitFor(() => expect(account()).toBe("@mara"));
    expect(said()).toBe("Code review in the Work profile reads and posts as @mara.");
  });

  it("names the other profile and its own account once the window is in that profile", async () => {
    const { store } = await mount({ spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Homework")] });
    await listed();
    status = { state: "ready", login: "mara", reason: null, account: "mara" };
    await act(async () => { await store.getState().selectProfile("p2"); });
    await waitFor(() => expect(account()).toBe("@mara"));
    expect(named()).toBe("School");
  });

  it("says nothing where gh is ready and names nobody, with no profile left standing alone", async () => {
    status = { state: "ready", login: null, reason: null };
    await mount();
    await waitFor(() => expect(document.querySelector("nav.cr-col")).not.toBeNull());
    expect(whose()!.childElementCount).toBe(0);
    expect(whose()).not.toHaveAttribute("title");
  });

  it("keeps its place in the head before gh has said who is signed in, and says nothing there yet", async () => {
    let answer!: () => void;
    statusGate = new Promise<void>((resolve) => { answer = resolve; });
    await mount();
    await waitFor(() => expect(called("codeReview.status")).toHaveLength(1));
    const pending = document.querySelector(".cr-col[aria-hidden] > .cr-col-head")!;
    expect([...pending.children].map((el) => el.className)).toEqual(["cr-col-title", "cr-col-as", "icon-btn"]);
    expect(pending.querySelector(".cr-col-as")!.textContent).toBe("");
    await act(async () => { answer(); });
    await waitFor(() => expect(account()).toBe("@carlton"));
  });
});

describe("an account picked away from the page", () => {
  const account = () => document.querySelector("nav.cr-col .cr-col-as-login")?.textContent ?? null;
  const listed = () => screen.findByRole("button", { name: /^Stream the tokenizer/ });

  it("is followed by the page that is open: it asks who it reads as again, and reads its lists as that account", async () => {
    await mount();
    await listed();
    const before = called("codeReview.status").length;
    status = { state: "ready", login: "mara", reason: null, account: "mara" };
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p1" }); });
    await waitFor(() => expect(account()).toBe("@mara"));
    expect(called("codeReview.status").slice(before).map((c) => c.params)).toEqual([{ force: false, profileId: "p1" }]);
    await waitFor(() => expect(called("codeReview.list").some((c) => c.params.account === "mara")).toBe(true));
  });

  it("leaves a page alone when the pick was for another profile", async () => {
    await mount();
    await listed();
    const before = called("codeReview.status").length;
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p2" }); });
    expect(called("codeReview.status")).toHaveLength(before);
  });

  it("stops listening when the page is put away", async () => {
    await mount();
    await listed();
    cleanup();
    expect(heard.get("codeReview.accountChanged")?.size ?? 0).toBe(0);
  });

  it("does not draw an answer it asked for before the pick, when that comes back after the one asked on hearing of it", async () => {
    const answers: ((s: GhStatus) => void)[] = [];
    statusFor = () => new Promise<GhStatus>((resolve) => { answers.push(resolve); });
    await mount();
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p1" }); });
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => { answers[1]!({ state: "ready", login: "mara", reason: null, account: "mara" }); });
    await waitFor(() => expect(account()).toBe("@mara"));
    await act(async () => { answers[0]!({ state: "ready", login: "carlton", reason: null }); });
    expect(account()).toBe("@mara");
  });

  it("draws a fresh answer that comes back after a held one asked later, where no pick came between them", async () => {
    signInSent();
    const answers: { force: boolean; go: (s: GhStatus) => void }[] = [];
    statusFor = () => new Promise<GhStatus>((resolve) => { answers.push({ force: calls.filter((c) => c.method === "codeReview.status").at(-1)!.params.force, go: resolve }); });
    const store = createAppStore(fakeApi({}));
    await store.getState().boot();
    render(<StrictMode><StoreContext.Provider value={store}>
      <CodeReviewPage item={item("cr", "s1", { kind: "code-review-page", title: "Code review", refId: PAGE_REF_IDS["code-review-page"] })} visible />
    </StoreContext.Provider></StrictMode>);
    await waitFor(() => expect(answers.map((a) => a.force)).toEqual([true, false]));
    await act(async () => { answers[1]!.go({ state: "ready", login: "carlton", reason: null }); });
    await waitFor(() => expect(account()).toBe("@carlton"));
    await act(async () => { answers[0]!.go({ state: "ready", login: "mara", reason: null }); });
    await waitFor(() => expect(account()).toBe("@mara"));
  });

  it("asks who is signed in again on Refresh, so the head follows a gh that a terminal switched", async () => {
    accounts = ["carlton", "mara"];
    await mount();
    await listed();
    const before = called("codeReview.status").length;
    status = { state: "ready", login: "mara", reason: null };
    fireEvent.click(await screen.findByRole("button", { name: "Code review options" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Code review options" })).getByRole("menuitem", { name: "Refresh" }));
    await waitFor(() => expect(account()).toBe("@mara"));
    expect(called("codeReview.status").slice(before).map((c) => c.params)).toEqual([{ force: true, profileId: "p1" }]);
  });
});

describe("Refresh, with a request being read", () => {
  const refresh = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Code review options" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Code review options" })).getByRole("menuitem", { name: "Refresh" }));
  };

  it("keeps the page and the request on it when GitHub cannot be reached: the lists say so in place", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Stream the tokenizer/ }));
    await screen.findByRole("heading", { level: 2, name: "Stream the tokenizer" });
    const before = called("codeReview.status").length;
    status = { state: "unreachable", login: null, reason: "error connecting to api.github.com" };
    await refresh();
    await waitFor(() => expect(called("codeReview.status").length).toBe(before + 1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/^GitHub did not answer/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Stream the tokenizer" })).toBeInTheDocument();
    expect(document.querySelector("nav.cr-col .cr-col-as-login")!.textContent).toBe("@carlton");
  });

  it("keeps them as well when the question itself is refused: a gh that hangs, or a socket that dropped", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Stream the tokenizer/ }));
    await screen.findByRole("heading", { level: 2, name: "Stream the tokenizer" });
    const before = called("codeReview.status").length;
    statusFor = () => Promise.reject(new Error("GitHub took too long to answer"));
    await refresh();
    await waitFor(() => expect(called("codeReview.status").length).toBe(before + 1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/^GitHub did not answer/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Stream the tokenizer" })).toBeInTheDocument();
    expect(document.querySelector("nav.cr-col .cr-col-as-login")!.textContent).toBe("@carlton");
  });

  it("does not draw what it learned when a pick was heard of since it asked", async () => {
    accounts = ["carlton", "mara"];
    await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    const answers: ((s: GhStatus) => void)[] = [];
    statusFor = () => new Promise<GhStatus>((resolve) => { answers.push(resolve); });
    await refresh();
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p1" }); });
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => { answers[1]!({ state: "ready", login: "mara", reason: null, account: "mara" }); });
    await waitFor(() => expect(document.querySelector("nav.cr-col .cr-col-as-login")!.textContent).toBe("@mara"));
    await act(async () => { answers[0]!({ state: "ready", login: "carlton", reason: null }); });
    expect(document.querySelector("nav.cr-col .cr-col-as-login")!.textContent).toBe("@mara");
  });

  it("goes to setting gh up when gh turns out to be signed out", async () => {
    await mount();
    await screen.findByRole("button", { name: /^Stream the tokenizer/ });
    status = { state: "signed-out", login: null, reason: null };
    await refresh();
    expect(await screen.findByRole("button", { name: "Set up GitHub" })).toBeInTheDocument();
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
    expect(called("codeReview.review")[0]!.params).toEqual({ ref, profileId: "p1", spaceId: "s1", projectId: null, agentKind: "claude", model: null, effort: null, fastMode: false });
    expect(await screen.findByRole("button", { name: "Reviewing…" })).toBeDisabled();
    expect(called("codeReview.submit")).toHaveLength(0);
  });

  /** The popover hook arms its outside-press and Escape listeners on a 0ms timeout, so the press that
   *  opened a surface cannot close it. Nothing below reaches them until this has run. */
  const armed = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const openMenu = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Review instructions" }));
    const sheet = await screen.findByRole("dialog", { name: "Review instructions" });
    await armed();
    return sheet;
  };
  const openPicker = async (sheet: HTMLElement) => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Model" }));
    const picker = await screen.findByRole("dialog", { name: "Model picker" });
    await armed();
    return picker;
  };

  it("is one control — the harness's mark and the model's name, then a chevron that opens how to review", async () => {
    /* The owner, 10-05: "instead of a settings button, you have a little drop-down button next to the
       model name… combine the buttons together too instead of having two separate ones." THE MUTANTS:
       the mark left off the body, or the gear back beside it. */
    await mount();
    await openRequest();
    const group = screen.getByRole("group", { name: "Review with a model" });
    const body = within(group).getByRole("button", { name: "Review with Fable 5.1" });
    const chevron = within(group).getByRole("button", { name: "Review instructions" });
    expect(body.querySelector('svg[data-brand="claude"]')).not.toBeNull();
    // Two targets in one group, the body first: the chevron is the second stop for Tab.
    expect(within(group).getAllByRole("button")).toEqual([body, chevron]);
    expect(chevron).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(chevron);
    expect(await screen.findByRole("dialog", { name: "Review instructions" })).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });

  it("chooses the model in the prompter's own picker, each under its harness's mark, and the menu stays up for it", async () => {
    await mount();
    await openRequest();
    const sheet = await openMenu();
    // The chip in the menu is the prompter's: the harness's mark beside the model's name.
    expect(within(sheet).getByRole("button", { name: "Model" }).querySelector('svg[data-brand="claude"]')).not.toBeNull();
    const picker = await openPicker(sheet);
    const claude = within(picker).getByRole("group", { name: "Claude" });
    for (const row of within(claude).getAllByRole("option")) expect(row.querySelector('svg[data-brand="claude"]')).not.toBeNull();
    // A press in the picker, which is portalled out of the menu, is not a press outside the menu.
    // THE MUTANT: the hook's own surface as the only inside — the menu closes under the pick.
    const opus = within(claude).getByRole("option", { name: /^Claude Opus 5\.5/ });
    fireEvent.pointerDown(opus);
    fireEvent.click(opus);
    await exited();
    expect(screen.getByRole("dialog", { name: "Review instructions" })).not.toHaveAttribute("data-closing");
    const body = screen.getByRole("button", { name: "Review with Opus 5.5" });
    fireEvent.click(body);
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.review")[0]!.params).toMatchObject({ agentKind: "claude", model: "claude-opus-5-5" });
  });

  it("puts the picker away on Escape before the menu, and the menu on the next", async () => {
    // THE MUTANT: every surface answering Escape — the menu, mounted first, went first and took the
    // picker on top of it with it.
    await mount();
    await openRequest();
    const sheet = await openMenu();
    await openPicker(sheet);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "Escape" });
    await exited();
    expect(screen.queryByRole("dialog", { name: "Model picker" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Review instructions" })).not.toHaveAttribute("data-closing");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await exited();
    expect(screen.queryByRole("dialog", { name: "Review instructions" })).toBeNull();
  });

  it("while a review runs, is that review under its reviewer's mark — and the chevron still opens the menu, whose Save and run says why it waits", async () => {
    // A review on Codex is running; the pick has moved on to Claude since.
    review = { ...REVIEW, agentKind: "codex", state: "running", summary: "", findings: [], finishedAt: null };
    await mount();
    await openRequest();
    const body = await screen.findByRole("button", { name: "Reviewing…" });
    expect(body).toBeDisabled();
    expect(body).toHaveAttribute("aria-busy", "true");
    // THE MUTANT: the pick's mark on a review it is not running.
    expect(body.querySelector('svg[data-brand="openai"]')).not.toBeNull();
    expect(body).toHaveAttribute("title", "GPT-5.6 is reviewing this pull request");
    // THE MUTANT: the chevron disabled with the body — the next review's model and instructions out
    // of reach for as long as this one runs.
    const chevron = screen.getByRole("button", { name: "Review instructions" });
    expect(chevron).toBeEnabled();
    const sheet = await openMenu();
    await waitFor(() => expect(within(sheet).getByRole("textbox", { name: "Review instructions" })).toBeEnabled());
    const saveAndRun = within(sheet).getByRole("button", { name: "Save and run" });
    expect(saveAndRun).toBeDisabled();
    expect(saveAndRun).toHaveAttribute("title", "A review of this pull request is running — its findings land here when it is done");
  });

  it("cannot review a request that changes nothing, says so, and still opens the menu", async () => {
    detail = { ...DETAIL, additions: 0, deletions: 0, changedFiles: 0 };
    await mount();
    await openRequest();
    const body = screen.getByRole("button", { name: "Review with Fable 5.1" });
    expect(body).toBeDisabled();
    expect(body).toHaveAttribute("title", "This pull request changes no files, so there is nothing to review");
    expect(screen.getByRole("button", { name: "Review instructions" })).toBeEnabled();
  });

  it("heads a finding under its line with the reviewer's mark and its model's name", async () => {
    // THE MUTANT: a bare note — beside the person's own comments, nothing says the reviewer wrote it.
    review = REVIEW;
    await mount();
    await openRequest();
    fireEvent.click(screen.getByRole("radio", { name: /Changes/ }));
    const note = (await screen.findByText("Carry the partial token.")).closest(".cr-note")!;
    const by = note.querySelector(".cr-note-by")!;
    expect(by).toHaveTextContent("Fable 5.1");
    expect(by.querySelector('svg[data-brand="claude"]')).not.toBeNull();
  });

  it("sets the reviewer's level and fast mode on the picker's own card, says them on the body, and the review runs at them", async () => {
    /* The owner, 10-06: "The reviewer effort level can do that as well" — the card the prompter's
       picker has, where this one had none. THE MUTANTS: the card left off this picker, the level or the
       speed dropped on the way to the review, or the body silent about what it will run at. */
    await mount();
    await openRequest();
    const sheet = await openMenu();
    const picker = await openPicker(sheet);
    // The model's own levels, its default named while none is set.
    expect(within(picker).getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "High");
    fireEvent.keyDown(within(picker).getByRole("slider", { name: "Effort" }), { key: "End" });
    await waitFor(() => expect(within(picker).getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "Max"));
    fireEvent.click(within(picker).getByRole("button", { name: "Fast mode" }));
    await waitFor(() => expect(within(picker).getByRole("button", { name: "Fast mode" })).toHaveAttribute("aria-pressed", "true"));
    // The menu's chip says it as the prompter's does, and the body after it.
    const chip = within(sheet).getByRole("button", { name: "Model" });
    expect(chip.querySelector(".chip-effort")).toHaveTextContent("Max");
    expect(chip.querySelector(".chip-fast")).not.toBeNull();
    const body = screen.getByRole("button", { name: "Review with Fable 5.1 Max in fast mode" });
    expect(body.querySelector(".cr-level")).toHaveTextContent("Max");
    // The profile's as each was set: there is no Save for a pick.
    expect(called("codeReview.setReviewerPick").at(-1)!.params).toEqual({ profileId: "p1", pick: { agentKind: "claude", model: null, effort: "max", fastMode: true } });
    fireEvent.click(body);
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.review")[0]!.params).toMatchObject({ agentKind: "claude", model: null, effort: "max", fastMode: true });
  });

  it("is the profile's reviewer in the next window — the model, its level and the bolt — and its review runs at them", async () => {
    // THE MUTANT: the pick held for the window alone, so a relaunch is back on the default at its default.
    reviewerPick = { agentKind: "claude", model: "claude-opus-5-5", effort: "xhigh", fastMode: true };
    await mount();
    await openRequest();
    const body = await screen.findByRole("button", { name: "Review with Opus 5.5 XHigh in fast mode" });
    expect(body).toHaveAttribute("title", "A read-only Opus 5.5 at XHigh effort in fast mode reads the diff and leaves findings for you — nothing is posted");
    fireEvent.click(body);
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.review")[0]!.params).toMatchObject({ agentKind: "claude", model: "claude-opus-5-5", effort: "xhigh", fastMode: true });
  });

  it("gives a level the newly picked model does not take to that model's own default — on the card, the body and the review — and has it back with one that does", async () => {
    /* As the prompter does: a session's row keeps a level set under another model, and the card shows
       what runs in its place. THE MUTANT: the held level sent to a model that does not take it. */
    reviewerPick = { agentKind: "claude", model: "claude-opus-5-5", effort: "max", fastMode: false };
    await mount({ settings: { [MODEL_EFFORTS_KEY]: { "claude:claude-sonnet-5": ["low", "medium", "high"] } } });
    await openRequest();
    await screen.findByRole("button", { name: "Review with Opus 5.5 Max" });
    const sheet = await openMenu();
    const picker = await openPicker(sheet);
    const pick = (name: RegExp) => { const row = within(picker).getByRole("option", { name }); fireEvent.pointerDown(row); fireEvent.click(row); };
    pick(/^Claude Sonnet 5/);
    const track = await within(picker).findByRole("slider", { name: "Effort" });
    await waitFor(() => expect(track).toHaveAttribute("aria-valuemax", "2"));
    expect(track).toHaveAttribute("aria-valuetext", "High");
    // Its own default is what runs, so there is nothing to put back.
    expect(within(picker).queryByRole("button", { name: "Reset effort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review with Sonnet 5" })).toBeInTheDocument();
    expect(reviewerPick).toEqual({ agentKind: "claude", model: "claude-sonnet-5", effort: "max", fastMode: false });
    pick(/^Claude Opus 5\.5/);
    expect(await screen.findByRole("button", { name: "Review with Opus 5.5 Max" })).toBeInTheDocument();
    pick(/^Claude Sonnet 5/);
    fireEvent.click(await screen.findByRole("button", { name: "Review with Sonnet 5" }));
    await waitFor(() => expect(called("codeReview.review")).toHaveLength(1));
    expect(called("codeReview.review")[0]!.params).toMatchObject({ model: "claude-sonnet-5", effort: null });
  });

  it("names the level a review was started at wherever it names the reviewer's model — over the run, and over each finding", async () => {
    // THE MUTANTS: the level left off either, or read from the pick rather than from the run.
    review = { ...REVIEW, effort: "xhigh" };
    await mount();
    await openRequest();
    const head = within(await screen.findByRole("region", { name: "Review" })).getByText(/^Review by/);
    expect(head).toHaveTextContent("Review by Fable 5.1 XHigh");
    expect(head.querySelector(".cr-level")).toHaveTextContent("XHigh");
    fireEvent.click(screen.getByRole("radio", { name: /Changes/ }));
    const note = (await screen.findByText("Carry the partial token.")).closest(".cr-note")!;
    expect(note.querySelector(".cr-note-by")).toHaveTextContent("Fable 5.1 XHigh");
  });

  it("while a review runs at a level, says it over the run and in the body's tooltip", async () => {
    review = { ...REVIEW, effort: "xhigh", state: "running", summary: "", findings: [], finishedAt: null };
    await mount();
    await openRequest();
    expect(await screen.findByRole("button", { name: "Reviewing…" })).toHaveAttribute("title", "Fable 5.1 at XHigh effort is reviewing this pull request");
    expect(within(screen.getByRole("region", { name: "Review" })).getByText(/is reviewing…$/)).toHaveTextContent("Fable 5.1 XHigh is reviewing…");
  });

  it("keeps the profile's instructions from the chevron, with an example a press away, and Save and run runs", async () => {
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

describe("Ask about this pull request", () => {
  it("answers the card before there is a session, and the first question starts one at that level and speed", async () => {
    /* THE BUG the owner hit: with no session behind it yet, this prompter held the model picked and
       dropped every press on the card — the bolt and the track were drawn, took the click, and did
       nothing. THE MUTANTS: drop the draft's options again, or leave them off the first question. */
    await mount();
    await openRequest();
    const ask = screen.getByRole("region", { name: "Ask about this pull request" });
    fireEvent.click(within(ask).getByRole("button", { name: "Model" }));
    fireEvent.keyDown(await screen.findByRole("slider", { name: "Effort" }), { key: "End" });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "Max"));
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fast mode" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(ask).getByRole("button", { name: "Model" }).querySelector(".chip-effort")).toHaveTextContent("Max");
    const box = within(ask).getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "Is the stream right?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(called("codeReview.ask")).toHaveLength(1));
    expect(called("codeReview.ask")[0]!.params).toMatchObject({ effort: "max", fastMode: true, permissionMode: null, model: null });
  });
});

describe("the column, in the sidebar's place", () => {
  /** The page as the window shows it: over the panes, beside the real sidebar, whose column a page's
   *  sections can take (components/page-nav.tsx). Opened in a sync act, so what is asserted right
   *  after is the page's first frame — gh's answer is a promise that has not settled yet. */
  async function mountInWindow(data: FakeData = {}) {
    const store = createAppStore(fakeApi(data));
    await store.getState().boot();
    render(
      <StoreContext.Provider value={store}>
        <PageNavProvider>
          <Sidebar collapsed={store.getState().sidebarCollapsed} />
          <PageOverlay />
        </PageNavProvider>
      </StoreContext.Provider>,
    );
    act(() => store.getState().openDestinationPage("code-review-page"));
    return { store };
  }
  const sidebar = () => document.getElementById("app-sidebar")!;
  const page = () => document.querySelector<HTMLElement>(".page-overlay")!;
  const column = () => within(sidebar()).getByRole("navigation", { name: "Pull requests" });

  it("is the sidebar's column from the page's first frame — before gh has answered — with no Back, and none of it in the page", async () => {
    /* The owner, 10-05, of the Scheduled page's column: "It is supposed to be the replacement sidebar,
       not like its own custom thing. Same for the code review part." And from the first frame: a page
       that waited for gh before drawing its column showed the spaces until it answered, then swapped.
       Of the Back over it, later that day: "unnecessary" — the rail's lit button puts the page away.
       THE MUTANTS: the column left in the page, nothing in the sidebar's place until gh answers, or a
       Back over it again. */
    const { store } = await mountInWindow();
    // Its first frame: the column's picture in the slot, in the spaces' place — and beside it the page
    // as it will stand once gh answers, nothing chosen yet.
    expect(sidebar().querySelector(".sb-page-nav > .cr-col[aria-hidden]")).not.toBeNull();
    expect(within(page()).getByRole("heading", { level: 2, name: "Select a pull request" })).toBeInTheDocument();
    expect(within(sidebar()).queryByRole("button", { name: "Back" })).toBeNull();
    expect(sidebar().querySelector(".sb-list")).toHaveAttribute("hidden");
    // gh answers: the column itself in the same place, its lists under the head, the page its own.
    expect(await within(sidebar()).findByRole("button", { name: /^Stream the tokenizer/ })).toBeInTheDocument();
    expect(column().closest(".sb-page-nav")).not.toBeNull();
    expect(within(sidebar()).queryByRole("button", { name: "Back" })).toBeNull();
    expect(sidebar().querySelector(".cr-col[aria-hidden]")).toBeNull();
    expect(page().querySelector(".cr-col")).toBeNull();
    fireEvent.click(within(column()).getByRole("button", { name: /^Stream the tokenizer/ }));
    expect(await within(page()).findByRole("heading", { level: 2, name: "Stream the tokenizer" })).toBeInTheDocument();
    // Opened again, it is drawn as it was left in its first frame: what gh said, and the lists.
    act(() => store.getState().closePageOverlay());
    act(() => store.getState().openDestinationPage("code-review-page"));
    expect(sidebar().querySelector(".cr-col[aria-hidden]")).toBeNull();
    expect(within(column()).getByRole("button", { name: /^Stream the tokenizer/ })).toBeInTheDocument();
  });

  it("gives the column back to the spaces while gh is not set up — the page is its setup then", async () => {
    // THE MUTANT: a column left claiming the sidebar over a page that has nothing to list in it.
    status = { state: "signed-out", login: null, reason: null };
    await mountInWindow();
    expect(await within(page()).findByRole("button", { name: "Set up GitHub" })).toBeInTheDocument();
    expect(sidebar().querySelector(".sb-page")).toBeNull();
    expect(sidebar().querySelector(".sb-list")).not.toHaveAttribute("hidden");
  });

  it("stands in the page while the sidebar is folded away, where it can still be reached", async () => {
    // THE MUTANT: a column portalled into a sidebar that is off the window and inert.
    await mountInWindow({ settings: { "ui.sidebarCollapsed": true } });
    expect(await within(page()).findByRole("button", { name: /^Stream the tokenizer/ })).toBeInTheDocument();
    expect(sidebar().querySelector(".sb-page")).toBeNull();
  });
});

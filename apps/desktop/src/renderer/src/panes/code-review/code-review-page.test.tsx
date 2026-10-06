import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type FileDiff, type GhStatus, type PrDetail, type PrFiles, type PrPage, type PrReview, type PrSummary } from "@realm/contracts";

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
        case "codeReview.files": return FILES;
        case "codeReview.patches": return { patches: [PATCH] };
        case "codeReview.reviewGet": return { review };
        case "codeReview.pins": return { pins: [] };
        case "codeReview.places": return { places: [{ spaceId: "s1", projectId: null, name: "Versed", path: "/tmp/versed", repo: null, branch: null }] };
        case "codeReview.thread": return { sessionId: null, spaceId: null };
        case "codeReview.ask": return { sessionId: "01HQ000000000000000000ASK1", itemId: null };
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
import { exited } from "../../components/popover-exit.test-fakes";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";
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
  ref, headSha: "abc1234def", sessionId: "01HQ000000000000000000SES1", spaceId: "s1", agentKind: "claude", model: null, state: "done",
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

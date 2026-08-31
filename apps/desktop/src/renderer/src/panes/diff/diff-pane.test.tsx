import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { DiffFile, DiffSummary, Environment, FileDiff, ShipResult } from "@realm/contracts";
import { StoreContext, createAppStore, patchKey } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";
import { DiffPane } from "./DiffPane";

const CWD = "/tmp/worktrees/s1/fix-login";
const env = (extra: Partial<Environment> = {}): Environment =>
  ({ id: "env1", spaceId: "s1", path: CWD, branch: "realm/fix-login", kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0, ...extra });

const file = (path: string, extra: Partial<DiffFile> = {}): DiffFile =>
  ({ path, oldPath: null, status: "modified", staged: false, unstaged: true, binary: false, additions: 1, deletions: 0, ...extra });

const summary = (files: DiffFile[], extra: Partial<DiffSummary> = {}): DiffSummary =>
  ({ root: CWD, branch: "realm/fix-login", files, totalFiles: files.length, truncated: false, ...extra });

const patch = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path, oldPath: null, staged: false, binary: false, truncated: false, truncatedReason: null, additions: 1, deletions: 1,
  hunks: [{ header: "fn main", oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [
    { kind: "context", text: "keep", oldLine: 10, newLine: 10 },
    { kind: "del", text: "old line", oldLine: 11, newLine: null },
    { kind: "add", text: "new line", oldLine: null, newLine: 11 },
  ] }],
  ...extra,
});

async function mount(data: FakeData = {}, diffs: Record<string, DiffSummary | null> = { [CWD]: summary([file("src/a.ts")]) }) {
  const api = fakeApi({
    environments: { s1: [env()] },
    sessions: [session("se1", "s1", { environmentId: "env1", cwd: CWD })],
    diffs,
    checkpoints: { env1: [] },
    ...data,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(
    <StoreContext.Provider value={store}>
      <DiffPane item={item("i9", "s1", { kind: "diff", refId: "env1", title: "Changes" })} visible />
    </StoreContext.Provider>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.startsWith(`diff:${CWD}`))).toBe(true));
  return { api, store, ...r };
}

const rowFor = (path: string) => screen.getByText(path.split("/").pop()!).closest(".diff-file") as HTMLElement;

describe("DiffPane", () => {
  it("lists changed files with their counts and the branch", async () => {
    await mount({}, { [CWD]: summary([file("src/a.ts", { additions: 3, deletions: 1 }), file("README.md", { status: "untracked", additions: 0 })]) });
    expect(screen.getByText("realm/fix-login")).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    const row = rowFor("src/a.ts");
    expect(within(row).getByText("+3")).toBeInTheDocument();
    expect(within(row).getByText("−1")).toBeInTheDocument();
    // The directory is a dimmer tier of the same label, not a second line.
    expect(within(row).getByText("src/")).toBeInTheDocument();
    expect(within(rowFor("README.md")).getByText("?")).toBeInTheDocument();
  });

  it("fetches a file's patch only when the row is expanded", async () => {
    const { api } = await mount({ patches: { [`${CWD}|src/a.ts|false`]: patch("src/a.ts") } });
    expect(api.calls.some((c) => c.startsWith("fileDiff:"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Expand src\/a\.ts/ }));
    await waitFor(() => expect(screen.getByText("new line")).toBeInTheDocument());
    expect(api.calls.filter((c) => c.startsWith("fileDiff:"))).toEqual([`fileDiff:${CWD}|src/a.ts|false`]);
    // Line numbers come from the hunk header, not from a count starting at 1.
    const added = screen.getByText("new line").closest(".diff-line")!;
    expect(added).toHaveAttribute("data-kind", "add");
    expect(within(added as HTMLElement).getByText("11")).toBeInTheDocument();
  });

  it("shows a binary file's row without ever asking for its bytes", async () => {
    const { api } = await mount({ patches: { [`${CWD}|logo.png|false`]: patch("logo.png", { binary: true, hunks: [] }) } },
      { [CWD]: summary([file("logo.png", { binary: true, additions: 0, deletions: 0 })]) });
    expect(within(rowFor("logo.png")).getByText("binary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand logo\.png/ }));
    await waitFor(() => expect(screen.getByText("Binary file — no preview.")).toBeInTheDocument());
    expect(api.calls.filter((c) => c.startsWith("fileDiff:"))).toHaveLength(1);
  });

  it("stages exactly the file whose button was pressed", async () => {
    const { api } = await mount({}, { [CWD]: summary([file("src/a.ts"), file("src/b.ts")]) });
    fireEvent.click(within(rowFor("src/b.ts")).getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(api.calls).toContain(`stage:${CWD}|src/b.ts`));
    // The mutant this kills: staging the first file, or all of them.
    expect(api.calls.filter((c) => c.startsWith("stage:"))).toEqual([`stage:${CWD}|src/b.ts`]);
  });

  it("offers both sides for a file that is staged AND edited again, and drops its cached patches on staging", async () => {
    const both = file("src/a.ts", { staged: true, unstaged: true });
    const { api, store } = await mount({}, { [CWD]: summary([both]) });
    store.setState({ patches: {
      [patchKey(CWD, "src/a.ts", true)]: patch("src/a.ts", { staged: true }),
      [patchKey(CWD, "src/a.ts", false)]: patch("src/a.ts"),
    } });
    const row = rowFor("src/a.ts");
    expect(within(row).getByRole("button", { name: "Stage" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Unstage" })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(api.calls).toContain(`stage:${CWD}|src/a.ts`));
    // Both sides are gone: a patch cached before staging describes a state that no longer exists.
    expect(Object.keys(store.getState().patches)).toEqual([]);
  });

  it("stages everything with one press, naming every unstaged file", async () => {
    const { api } = await mount({}, { [CWD]: summary([file("a.ts"), file("b.ts"), file("c.ts", { staged: true, unstaged: false })]) });
    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("stage:"))).toBe(true));
    expect(api.calls.filter((c) => c.startsWith("stage:"))).toEqual([`stage:${CWD}|a.ts,b.ts`]);
  });

  it("refuses to ship without a message, and ships with one", async () => {
    const { api } = await mount({}, { [CWD]: summary([file("a.ts", { staged: true, unstaged: false })]) });
    const button = screen.getByRole("button", { name: /Commit, push & PR/ });
    expect(button).toBeDisabled(); // no message yet
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "  " } });
    expect(button).toBeDisabled(); // whitespace is not a message
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Fix the login flow" } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("ship:"))).toBe(true));
    expect(api.calls.find((c) => c.startsWith("ship:")))
      .toBe(`ship:${CWD}|commit=true|msg=Fix the login flow|push=true|upstream=false|pr=true`);
  });

  it("cannot ship with nothing staged", async () => {
    await mount({}, { [CWD]: summary([file("a.ts")]) }); // unstaged only
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "a message" } });
    expect(screen.getByRole("button", { name: /Commit, push & PR/ })).toBeDisabled();
    expect(screen.getByText("Nothing staged")).toBeInTheDocument();
  });

  it("explains a missing upstream and offers to set one, without committing twice", async () => {
    const noUpstream: ShipResult = {
      commit: { state: "committed", sha: "abc1234def", subject: "Fix it", reason: null },
      push: { state: "no-upstream", remote: "origin", branch: "realm/fix-login", reason: "realm/fix-login has never been pushed; origin does not know about it yet" },
      pr: { state: "skipped", url: null, reason: "the branch is not on the remote yet" },
    };
    const { api } = await mount({ shipResult: noUpstream }, { [CWD]: summary([file("a.ts", { staged: true, unstaged: false })]) });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Fix it" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit, push & PR/ }));
    await waitFor(() => expect(screen.getByText(/never been pushed/)).toBeInTheDocument());
    expect(screen.getByText("abc1234")).toBeInTheDocument(); // the commit that DID happen, short sha
    fireEvent.click(screen.getByRole("button", { name: "Push and set upstream" }));
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("ship:"))).toHaveLength(2));
    // The retry must not commit again — the commit already landed.
    expect(api.calls.filter((c) => c.startsWith("ship:"))[1]).toContain("commit=false");
    expect(api.calls.filter((c) => c.startsWith("ship:"))[1]).toContain("upstream=true");
  });

  it("gives a rejected push no fix button, only the explanation", async () => {
    const rejected: ShipResult = {
      commit: { state: "committed", sha: "aaa", subject: "x", reason: null },
      push: { state: "rejected", remote: "origin", branch: "main", reason: "origin has commits main does not — pull or rebase, then ship again" },
      pr: { state: "skipped", url: null, reason: null },
    };
    await mount({ shipResult: rejected }, { [CWD]: summary([file("a.ts", { staged: true, unstaged: false })]) });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit, push & PR/ }));
    await waitFor(() => expect(screen.getByText(/pull or rebase/)).toBeInTheDocument());
    // There is no force-push in Realm, so there must be no button offering one.
    expect(screen.queryByRole("button", { name: /force/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Push and set upstream/ })).toBeNull();
  });

  it("hands back a compare link when gh could not open the request", async () => {
    const compare: ShipResult = {
      commit: { state: "nothing-to-commit", sha: null, subject: null, reason: null },
      push: { state: "up-to-date", remote: "origin", branch: "main", reason: null },
      pr: { state: "compare", url: "https://github.com/acme/widgets/compare/main...feat?expand=1", reason: "gh is not installed — open this link to create the request" },
    };
    const { store } = await mount({ shipResult: compare }, { [CWD]: summary([file("a.ts", { staged: true, unstaged: false })]) });
    store.setState({ shipResults: { [CWD]: compare } });
    const link = await screen.findByRole("link", { name: "Open a pull request" });
    expect(link).toHaveAttribute("href", compare.pr.url);
  });

  it("says how many files it is NOT showing when the list was truncated", async () => {
    await mount({}, { [CWD]: summary([file("a.ts")], { totalFiles: 4213, truncated: true }) });
    expect(screen.getByText(/Showing 1 of 4213 changed files/)).toBeInTheDocument();
  });

  it("says a checkout that is not a repository has nothing to diff", async () => {
    await mount({}, { [CWD]: null });
    expect(await screen.findByText(/is not a git repository/)).toBeInTheDocument();
  });

  /**
   * The named mutant: a pane that captured its checkout path once would keep rendering the tree it
   * mounted on. The pane reads the ENVIRONMENT every render, so moving the row moves the pane.
   */
  it("follows its environment when the row's path changes, and refetches", async () => {
    const MOVED = "/tmp/worktrees/s1/moved";
    const { api, store } = await mount({ diffs: { [CWD]: summary([file("old.ts")]), [MOVED]: summary([file("new.ts")]) } },
      { [CWD]: summary([file("old.ts")]), [MOVED]: summary([file("new.ts")]) });
    expect(screen.getByText("old.ts")).toBeInTheDocument();
    store.setState({ environments: { env1: env({ path: MOVED }) } });
    await waitFor(() => expect(screen.getByText("new.ts")).toBeInTheDocument());
    expect(screen.queryByText("old.ts")).toBeNull();
    expect(api.calls).toContain(`diff:${MOVED}`);
  });

  it("says so when the environment is gone rather than showing another checkout's tree", async () => {
    const { store } = await mount();
    store.setState({ environments: {} });
    await waitFor(() => expect(screen.getByText("This checkout no longer exists.")).toBeInTheDocument());
  });
});

describe("checkpoint history", () => {
  it("opens the checkout's checkpoints from the header, scoped to the environment", async () => {
    const { api, store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(api.calls).toContain("listCheckpoints:env1|*"));
    expect(store.getState().sheet).toEqual({ kind: "checkpoints", environmentId: "env1", sessionId: null });
  });
});

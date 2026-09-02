import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Environment, WorktreeStatus } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, session } from "../state/store.test-fakes";
import { RemoveWorktreeSheet, hazardSentence } from "./RemoveWorktreeSheet";

const PATH = "/tmp/worktrees/s1/fix-login";
const env: Environment = { id: "env1", spaceId: "s1", path: PATH, branch: "realm/fix-login", kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 };
const status = (extra: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  environmentId: "env1", path: PATH, branch: "realm/fix-login", present: true,
  dirtyFiles: 0, unpushedCommits: 0, removable: true, blockedBy: null, ...extra,
});

async function open(st: WorktreeStatus) {
  const api = fakeApi({
    environments: { s1: [env] },
    sessions: [session("se1", "s1", { environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })],
    worktreeStatus: { env1: st },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().askRemoveWorktree("env1");
  const r = render(<StoreContext.Provider value={store}><RemoveWorktreeSheet environmentId="env1" /></StoreContext.Provider>);
  return { api, store, ...r };
}

describe("hazardSentence", () => {
  it("names the exact counts, singular and plural", () => {
    expect(hazardSentence(status({ dirtyFiles: 1, unpushedCommits: 0 }))).toBe("This will destroy 1 uncommitted file. There is no undo.");
    expect(hazardSentence(status({ dirtyFiles: 3, unpushedCommits: 2 }))).toBe("This will destroy 3 uncommitted files and 2 unpushed commits. There is no undo.");
    expect(hazardSentence(status())).toMatch(/Nothing here is unsaved/);
  });
});

describe("RemoveWorktreeSheet", () => {
  it("names what would be lost before asking", async () => {
    await open(status({ dirtyFiles: 2, unpushedCommits: 1 }));
    expect(screen.getByText("This will destroy 2 uncommitted files and 1 unpushed commit. There is no undo.")).toBeInTheDocument();
    expect(screen.getByText("realm/fix-login")).toBeInTheDocument();
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove and lose that work" })).toBeEnabled();
  });

  /**
   * The named mutant: a dialog that passes the acknowledgement it is DISPLAYING. The server refuses a
   * stale one, so the store re-reads immediately before removing — and the re-read is what is sent.
   */
  it("re-reads the hazard at the moment of confirming and sends those numbers", async () => {
    const { api } = await open(status({ dirtyFiles: 2, unpushedCommits: 1 }));
    const before = api.calls.filter((c) => c.startsWith("worktreeStatus:")).length;
    fireEvent.click(screen.getByRole("button", { name: "Remove and lose that work" }));
    await waitFor(() => expect(api.calls).toContain("removeWorktree:env1|2,1"));
    // A second read happened, and it happened BEFORE the removal.
    const reads = api.calls.filter((c) => c.startsWith("worktreeStatus:")).length;
    expect(reads).toBe(before + 1);
    expect(api.calls.indexOf("worktreeStatus:env1")).toBeLessThan(api.calls.indexOf("removeWorktree:env1|2,1"));
  });

  it("removes NOTHING when the tree moved while the dialog was open, and shows the new numbers", async () => {
    const { api, store } = await open(status({ dirtyFiles: 2, unpushedCommits: 1 }));
    // The agent wrote another file since the sheet opened. "Yes" now means something else.
    api.data.worktreeStatus.env1 = status({ dirtyFiles: 3, unpushedCommits: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Remove and lose that work" }));
    await waitFor(() => expect(screen.getByText(/The worktree changed while this was open/)).toBeInTheDocument());
    expect(api.calls.some((c) => c.startsWith("removeWorktree:"))).toBe(false);
    expect(screen.getByText("This will destroy 3 uncommitted files and 1 unpushed commit. There is no undo.")).toBeInTheDocument();
    // Confirming again — now against numbers the user has actually seen — goes through.
    fireEvent.click(screen.getByRole("button", { name: "Remove and lose that work" }));
    await waitFor(() => expect(api.calls).toContain("removeWorktree:env1|3,1"));
    expect(store.getState().sheet).toBeNull();
  });

  it("says plainly that a clean worktree loses nothing", async () => {
    const { api } = await open(status());
    expect(screen.getByText(/Nothing here is unsaved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls).toContain("removeWorktree:env1|0,0"));
  });

  it("refuses at the button when a session still runs there", async () => {
    const { api } = await open(status({ removable: false, blockedBy: "ENVIRONMENT_IN_USE" }));
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByText("A session still runs here. Close it first.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.startsWith("removeWorktree:"))).toBe(false);
  });

  it("says the directory is already gone when it is", async () => {
    await open(status({ present: false }));
    expect(screen.getByText(/directory is already gone/)).toBeInTheDocument();
  });

  it("closes the diff pane for the checkout it just removed", async () => {
    const api = fakeApi({
      environments: { s1: [env] },
      items: { s1: [{ id: "id1", spaceId: "s1", kind: "diff", title: "Changes", sortOrder: 0, pinned: false, archived: false, refId: "env1", createdAt: 0, updatedAt: 0 }] },
      worktreeStatus: { env1: status() },
    });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().askRemoveWorktree("env1");
    await store.getState().confirmRemoveWorktree("env1");
    expect(api.calls).toContain("deleteItem:id1");
    expect(store.getState().diffs[PATH]).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Environment, WorktreeStatus } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
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

  it("leaves the commits out when the branch is kept, because they stay on it", () => {
    expect(hazardSentence(status({ dirtyFiles: 1, unpushedCommits: 2 }), false)).toBe("This will destroy 1 uncommitted file. There is no undo.");
    expect(hazardSentence(status({ unpushedCommits: 2 }), false)).toBe("Nothing is lost: the 2 commits stay on the branch.");
  });
});

const branchBox = () => screen.getByRole("checkbox", { name: /Also delete the branch/ });

describe("RemoveWorktreeSheet", () => {
  it("names what would be lost before asking", async () => {
    await open(status({ dirtyFiles: 2, unpushedCommits: 1 }));
    fireEvent.click(branchBox());
    expect(screen.getByText("This will destroy 2 uncommitted files and 1 unpushed commit. There is no undo.")).toBeInTheDocument();
    expect(document.querySelector(".wt-target")).toHaveTextContent("realm/fix-login");
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove and lose that work" })).toBeEnabled();
  });

  it("keeps a branch with unpushed commits unless asked, and deletes one that holds nothing of its own", async () => {
    // THE MUTANT: the branch box ticked whatever is on it — the default would delete unpushed work.
    const { api } = await open(status({ unpushedCommits: 2 }));
    expect(branchBox()).not.toBeChecked();
    expect(screen.getByText("Nothing is lost: the 2 commits stay on the branch.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls).toContain("removeWorktree:env1|0,2|keep-branch"));
  });

  it("deletes the branch of a worktree that holds nothing of its own", async () => {
    const { api } = await open(status());
    expect(branchBox()).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls).toContain("removeWorktree:env1|0,0"));
  });

  /**
   * The named mutant: a dialog that passes the acknowledgement it is DISPLAYING. The server refuses a
   * stale one, so the store re-reads immediately before removing — and the re-read is what is sent.
   */
  it("re-reads the hazard at the moment of confirming and sends those numbers", async () => {
    const { api } = await open(status({ dirtyFiles: 2, unpushedCommits: 1 }));
    fireEvent.click(branchBox());
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
    fireEvent.click(branchBox());
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

  describe("with sessions still in it", () => {
    async function openWith(statusOf: Record<string, "idle" | "running">) {
      const ids = Object.keys(statusOf);
      const api = fakeApi({
        environments: { s1: [env] },
        sessions: ids.map((id) => session(id, "s1", { environmentId: "env1", title: `Session ${id}` })),
        items: { s1: ids.map((id) => item(`i-${id}`, "s1", { kind: "session", refId: id, title: `Session ${id}` })) },
        worktreeStatus: { env1: status({ removable: false, blockedBy: "ENVIRONMENT_IN_USE" }) },
      });
      const store = createAppStore(api);
      await store.getState().boot();
      store.setState({ sessionStatus: statusOf });
      await store.getState().askRemoveWorktree("env1");
      render(<StoreContext.Provider value={store}><RemoveWorktreeSheet environmentId="env1" /></StoreContext.Provider>);
      return { api, store };
    }

    it("names them, and removes nothing until deleting them too is ticked", async () => {
      // THE MUTANTS: a Remove that is live over sessions the server will refuse it for; one that
      // deletes them without asking.
      const { api, store } = await openWith({ a: "idle", b: "idle" });
      expect(screen.getByText("Session a")).toBeInTheDocument();
      expect(screen.getByText("Session b")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: /Delete these 2 sessions/ }));
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(api.calls).toContain("removeWorktree:env1|0,0"));
      // The sessions went first, through the path a session is deleted by.
      expect(api.calls.indexOf("deleteItem:i-a")).toBeLessThan(api.calls.indexOf("removeWorktree:env1|0,0"));
      expect(api.calls).toContain("deleteItem:i-b");
      expect(store.getState().sheet).toBeNull();
    });

    it("offers Stop on one that is running, and will not delete it while it runs", async () => {
      const { api } = await openWith({ a: "running" });
      expect(screen.getByRole("checkbox", { name: /Delete this session/ })).toBeDisabled();
      expect(screen.getByText("A session here is running. Stop it first.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(api.calls).toContain("interrupt:a"));
    });
  });

  it("refuses at the button when a session this window does not hold still works there", async () => {
    const { api } = await open(status({ removable: false, blockedBy: "ENVIRONMENT_IN_USE" }));
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByText(/A session in another profile still works here/)).toBeInTheDocument();
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

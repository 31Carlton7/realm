import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Environment } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { checkpoint, fakeApi, preview } from "../state/store.test-fakes";
import { CheckpointsSheet, relativeTime, restoreSentence } from "./CheckpointsSheet";

const PATH = "/tmp/worktrees/s1/fix-login";
const env: Environment = { id: "env1", spaceId: "s1", path: PATH, branch: "realm/fix-login", kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 };

async function open(opts: { checkpoints?: ReturnType<typeof checkpoint>[]; previews?: Record<string, ReturnType<typeof preview>>; sessionId?: string | null } = {}) {
  const api = fakeApi({
    environments: { s1: [env] },
    checkpoints: { env1: opts.checkpoints ?? [checkpoint("cp1", "env1", { label: "Add the login form", createdAt: Date.now() - 120_000 })] },
    checkpointPreview: opts.previews ?? { cp1: preview("cp1", "env1", { path: PATH, label: "Add the login form" }) },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openCheckpoints("env1", opts.sessionId ?? null);
  const r = render(<StoreContext.Provider value={store}><CheckpointsSheet environmentId="env1" sessionId={opts.sessionId ?? null} /></StoreContext.Provider>);
  return { api, store, ...r };
}

describe("restoreSentence", () => {
  it("names the exact counts, singular and plural", () => {
    expect(restoreSentence(preview("c", "e", { filesChanged: 1 }))).toBe("This rewrites 1 file to match the checkpoint.");
    expect(restoreSentence(preview("c", "e", { filesChanged: 4, commitsRolledBack: 2 }))).toBe("This rewrites 4 files and 2 commits to match the checkpoint.");
    expect(restoreSentence(preview("c", "e"))).toMatch(/already matches the checkpoint/);
  });
});

describe("relativeTime", () => {
  it("rounds to the coarsest unit that still says something", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 300_000, now)).toBe("5m ago");
    expect(relativeTime(now - 7_200_000, now)).toBe("2h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});

describe("CheckpointsSheet", () => {
  it("lists the checkpoints for the environment", async () => {
    await open({ checkpoints: [
      checkpoint("cp2", "env1", { kind: "pre-restore", label: "Before restoring “Add the login form”", createdAt: Date.now() }),
      checkpoint("cp1", "env1", { label: "Add the login form", createdAt: Date.now() - 120_000 }),
    ] });
    expect(screen.getByText("Add the login form")).toBeInTheDocument();
    expect(screen.getByText("Undo point")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
  });

  it("names what restoring would cost before asking, and says it is undoable", async () => {
    await open({ previews: { cp1: preview("cp1", "env1", { path: PATH, label: "Add the login form", filesChanged: 3, commitsRolledBack: 1 }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText("This rewrites 3 files and 1 commit to match the checkpoint.")).toBeInTheDocument());
    expect(screen.getByText(/captured first, and appears above as an undo point/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore and overwrite" })).toBeEnabled();
  });

  /** The honesty requirement: no adapter can rewind a conversation, so the sheet must not imply one. */
  it("says plainly that the agent keeps its memory of those turns", async () => {
    await open({ previews: { cp1: preview("cp1", "env1", { filesChanged: 2 }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText(/Files only — the agent keeps its memory/)).toBeInTheDocument());
  });

  it("says the branch will not move, and why, when it cannot", async () => {
    await open({ previews: { cp1: preview("cp1", "env1", { filesChanged: 1, headMovable: false, headReason: "the checkout is on other now, not fix-login" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText(/The branch will not move: the checkout is on other now/)).toBeInTheDocument());
  });

  /**
   * The named mutant: a dialog that passes the acknowledgement it is DISPLAYING. The server refuses a
   * stale one, so the store re-reads immediately before restoring — and the re-read is what is sent.
   */
  it("re-reads the preview at the moment of confirming and sends those numbers", async () => {
    const { api } = await open({ previews: { cp1: preview("cp1", "env1", { path: PATH, filesChanged: 2, commitsRolledBack: 1 }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore and overwrite" })).toBeInTheDocument());
    const before = api.calls.filter((c) => c.startsWith("previewCheckpoint:")).length;

    fireEvent.click(screen.getByRole("button", { name: "Restore and overwrite" }));
    await waitFor(() => expect(api.calls).toContain("restoreCheckpoint:cp1|2,1"));
    expect(api.calls.filter((c) => c.startsWith("previewCheckpoint:")).length).toBe(before + 1);
    expect(api.calls.lastIndexOf("previewCheckpoint:cp1")).toBeLessThan(api.calls.indexOf("restoreCheckpoint:cp1|2,1"));
  });

  it("restores NOTHING when the checkout moved while the confirm was open, and shows the new numbers", async () => {
    const { api } = await open({ previews: { cp1: preview("cp1", "env1", { path: PATH, filesChanged: 2, commitsRolledBack: 0 }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore and overwrite" })).toBeInTheDocument());

    // The agent wrote another file since the confirm opened. "Yes" now means something else.
    api.data.checkpointPreview.cp1 = preview("cp1", "env1", { path: PATH, filesChanged: 5, commitsRolledBack: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Restore and overwrite" }));
    await waitFor(() => expect(screen.getByText(/The checkout changed while this was open/)).toBeInTheDocument());
    expect(api.calls.some((c) => c.startsWith("restoreCheckpoint:"))).toBe(false);
    expect(screen.getByText("This rewrites 5 files to match the checkpoint.")).toBeInTheDocument();

    // Confirming again — now against numbers the user has actually seen — goes through.
    fireEvent.click(screen.getByRole("button", { name: "Restore and overwrite" }));
    await waitFor(() => expect(api.calls).toContain("restoreCheckpoint:cp1|5,0"));
  });

  it("refuses at the button when the checkpoint's objects are gone", async () => {
    await open({ previews: { cp1: preview("cp1", "env1", { intact: false }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText(/no longer in the repository/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  });

  it("reports what happened and leaves the new undo point in the list", async () => {
    const { store } = await open({ previews: { cp1: preview("cp1", "env1", { path: PATH, filesChanged: 2 }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore and overwrite" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Restore and overwrite" }));
    await waitFor(() => expect(screen.getByText(/Restored 2 files/)).toBeInTheDocument());
    expect(store.getState().checkpoints.env1?.[0]?.kind).toBe("pre-restore");
    expect(screen.getByText("Undo point")).toBeInTheDocument();
  });

  it("lists only the named session's turns when one is given", async () => {
    const { api } = await open({
      sessionId: "se1",
      checkpoints: [
        checkpoint("cp1", "env1", { sessionId: "se1", label: "mine" }),
        checkpoint("cp9", "env1", { sessionId: "se2", label: "someone else's" }),
      ],
    });
    expect(api.calls).toContain("listCheckpoints:env1|se1");
    expect(screen.getByText("mine")).toBeInTheDocument();
    expect(screen.queryByText("someone else's")).not.toBeInTheDocument();
  });

  it("explains the empty state rather than showing a blank list", async () => {
    await open({ checkpoints: [] });
    expect(screen.getByText(/Realm takes one before every message/)).toBeInTheDocument();
  });
});

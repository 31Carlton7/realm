import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Environment } from "@realm/contracts";
import { StoreContext, createAppStore } from "../state/store";
import { checkpoint, fakeApi, preview, session } from "../state/store.test-fakes";
import { CheckpointsSheet, relativeTime, restoreSentence } from "./CheckpointsSheet";
import { emptyTranscript } from "../panes/session/transcript-model";

const PATH = "/tmp/worktrees/s1/fix-login";
const env: Environment = { id: "env1", spaceId: "s1", path: PATH, branch: "realm/fix-login", kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 };

async function open(opts: { checkpoints?: ReturnType<typeof checkpoint>[]; previews?: Record<string, ReturnType<typeof preview>>; sessionId?: string | null; sessions?: ReturnType<typeof session>[] } = {}) {
  const api = fakeApi({
    environments: { s1: [env] },
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
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

  /** The honesty requirement, in the case where a rewind is NOT on offer — a non-Claude session, a
   *  checkpoint with no recorded cursor, or a provider conversation that has moved on. The sheet must
   *  not imply a rewind it cannot perform. */
  it("says plainly that the agent keeps its memory of those turns", async () => {
    await open({ previews: { cp1: preview("cp1", "env1", { filesChanged: 2 }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText(/Files only — the agent keeps its memory/)).toBeInTheDocument());
  });

  /** The other half, which the old copy denied was possible at all. THE MUTANT: render the negative
   *  sentence unconditionally — the sheet would then under-promise on exactly the restores that do
   *  rewind, which is the same dishonesty in the opposite direction. */
  it("says the conversation rewinds too when this checkpoint can carry it", async () => {
    await open({ previews: { cp1: preview("cp1", "env1", { filesChanged: 2, rewindsConversation: true }) } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText(/The conversation rewinds too/)).toBeInTheDocument());
    expect(screen.queryByText(/Files only/)).toBeNull();
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

  it("takes a manual checkpoint on request and shows it in the list", async () => {
    const { api } = await open({ checkpoints: [] });
    expect(screen.getByText(/Realm takes one before every message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Checkpoint now" }));
    await waitFor(() => expect(api.calls).toContain("captureCheckpoint:env1|*"));
    expect(await screen.findByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Manual checkpoint")).toBeInTheDocument();
  });

  it("explains the empty state rather than showing a blank list", async () => {
    await open({ checkpoints: [] });
    expect(screen.getByText(/Realm takes one before every message/)).toBeInTheDocument();
  });
});

describe("Fork from here (Plan 16 W3)", () => {
  const turnCp = () => checkpoint("cp1", "env1", { label: "Add the login form", sessionId: "se1", createdAt: Date.now() - 120_000 });

  async function openWithSession() {
    const api = fakeApi({
      environments: { s1: [env] },
      sessions: [session("se1", "s1", { title: "Login work", environmentId: "env1", cwd: PATH })],
      checkpoints: { env1: [turnCp()] },
      checkpointPreview: { cp1: preview("cp1", "env1", { path: PATH, label: "Add the login form" }) },
    });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openCheckpoints("env1", null);
    render(<StoreContext.Provider value={store}><CheckpointsSheet environmentId="env1" sessionId={null} /></StoreContext.Provider>);
    return { api, store };
  }

  it("offers Fork only on checkpoints a session's turn took, with the honest workspace-fork copy", async () => {
    await openWithSession();
    expect(screen.getByRole("button", { name: "Fork…" })).toBeInTheDocument();
    expect(screen.getByText(/conversation cannot be rewound/)).toBeInTheDocument();
    expect(screen.getByText(/carried into the new session as text/)).toBeInTheDocument();
    // …and the sentence that makes a cross-agent fork legible: it is the SAME mechanism, so landing
    // on another agent costs nothing a same-agent fork does not.
    expect(screen.getByText(/continuing on Codex costs nothing/)).toBeInTheDocument();
  });

  it("hides Fork (and the copy) for environment-level checkpoints — there is no session to fork", async () => {
    await open(); // default checkpoint(): sessionId null
    expect(screen.queryByRole("button", { name: "Fork…" })).toBeNull();
    expect(screen.queryByText(/conversation cannot be rewound/)).toBeNull();
  });

  it("Fork calls sessions.fork, closes the sheet, and opens the NEW session's pane — the ancestor untouched", async () => {
    const { api, store } = await openWithSession();
    const rowsBefore = JSON.stringify(api.data.sessions.find((x) => x.id === "se1"));
    fireEvent.click(screen.getByRole("button", { name: "Fork…" }));
    // The ancestor's own agent leads the menu: a same-agent fork is the ordinary case, and a menu
    // that buried it would punish the common choice.
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fork on Fake agent" }));
    // No `agentKind` on the wire for a same-agent fork — the server keeps the ancestor's, which is
    // the behaviour every existing fork already had.
    await waitFor(() => expect(api.calls).toContain("forkSession:cp1"));
    await waitFor(() => expect(store.getState().sheet).toBeNull());
    const forked = api.data.sessions.find((x) => x.dispatchedBy?.kind === "fork")!;
    expect(forked.dispatchedBy).toEqual({ kind: "fork", sessionId: "se1" });
    // The new pane is adopted into the layout and its environment merged.
    await waitFor(() => {
      const item = store.getState().items.find((i) => i.kind === "session" && i.refId === forked.id);
      expect(item).toBeDefined();
    });
    expect(store.getState().environments[forked.environmentId]).toMatchObject({ kind: "worktree" });
    expect(JSON.stringify(api.data.sessions.find((x) => x.id === "se1"))).toBe(rowsBefore);
  });

  it("forks onto a DIFFERENT agent when one is chosen", async () => {
    // The manual twin of failover's handoff. The transcript travels as text either way, which is
    // exactly why this is possible at all — and why it costs nothing a same-agent fork does not.
    const { api } = await openWithSession();
    fireEvent.click(screen.getByRole("button", { name: "Fork…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fork onto Codex" }));
    await waitFor(() => expect(api.calls).toContain("forkSession:cp1:codex"));
    const forked = api.data.sessions.find((x) => x.dispatchedBy?.kind === "fork")!;
    expect(forked.agentKind).toBe("codex");
  });
});

/**
 * The client half of a conversation rewind. The server truncates its own transcript; this window is
 * still holding the turns it cut, and `openSession` pages FORWARD from `lastSeq` — so unless the
 * cached entry is dropped first, the undone turns stay on screen and the restore looks broken.
 */
describe("a rewound restore repairs the transcript this window is holding", () => {
  const withSession = (rewinds: boolean) => ({
    sessionId: "se1",
    sessions: [session("se1", "s1", { title: "Login work", environmentId: "env1", cwd: PATH })],
    previews: { cp1: preview("cp1", "env1", { path: PATH, label: "Add the login form", filesChanged: 1, rewindsConversation: rewinds }) },
  });
  /** A transcript this client already paged to seq 99 — the state a truncation invalidates. */
  const holdTranscript = (store: { setState: (p: object) => void }) =>
    store.setState({ transcripts: { se1: { lastSeq: 99, t: emptyTranscript() } } });

  it("drops the cached transcript and re-reads it from the start", async () => {
    const { store, api } = await open(withSession(true));
    holdTranscript(store);
    // Arm the confirmation first: `confirmRestoreCheckpoint` refuses outright without a shown preview
    // to compare against, so calling it cold would pass this test for the wrong reason.
    await store.getState().askRestoreCheckpoint("cp1");
    await store.getState().confirmRestoreCheckpoint("cp1");
    /* THE MUTANT: reopen without clearing. `sessionEvents` would be asked for everything after seq
       99 — nothing — and the stale tail would survive the restore that was supposed to undo it. */
    expect(api.calls).toContain("sessionEvents:se1:0");
  });

  it("leaves the transcript alone when only the files were restored", async () => {
    const { store, api } = await open(withSession(false));
    holdTranscript(store);
    await store.getState().askRestoreCheckpoint("cp1");
    await store.getState().confirmRestoreCheckpoint("cp1");
    // Proof the restore really ran, so the assertion below is about the rewind and not about nothing.
    expect(store.getState().restoreResult?.conversationRewound).toBe(false);
    expect(api.calls.some((c) => c.startsWith("sessionEvents:se1"))).toBe(false);
    expect(store.getState().transcripts.se1?.lastSeq).toBe(99);
  });
});

import { describe, expect, it } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { SpacePage } from "./SpacePage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, checkpoint, item, session, shipRow, type FakeData } from "../../state/store.test-fakes";
import type { Environment } from "@realm/contracts";

/** The page pane as PaneHost mounts it: an item whose refId is the SPACE id (Plan 12 W3). */
const pageItem = (spaceId: string) => item(`pg-${spaceId}`, spaceId, { kind: "space-page", title: "Overview", refId: spaceId });

async function mount(overrides: FakeData = {}, spaceId = "s1") {
  const api = fakeApi(overrides); const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SpacePage item={pageItem(spaceId)} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

/* ——— Ported verbatim from the retired SpaceSettingsSheet suite: the General tab IS the old sheet. ——— */

describe("SpacePage · General", () => {
  it("renames on blur, picks icon/color/profile, custom hex only when valid", async () => {
    const { store } = await mount();
    const name = screen.getByRole("textbox", { name: "Space name" });
    fireEvent.change(name, { target: { value: "Versed 2" } }); fireEvent.blur(name);
    await waitFor(() => expect(store.getState().activeSpace()?.name).toBe("Versed 2"));
    fireEvent.click(screen.getByRole("button", { name: "Change icon…" }));
    fireEvent.click(screen.getByRole("radio", { name: "Icon cap" }));
    await waitFor(() => expect(store.getState().activeSpace()?.icon).toBe("cap"));
    fireEvent.click(screen.getByRole("radio", { name: "Color #3ddc97" }));
    await waitFor(() => expect(store.getState().activeSpace()?.color).toBe("#3ddc97"));
    const hex = screen.getByRole("textbox", { name: "Custom color" });
    fireEvent.change(hex, { target: { value: "#12" } });
    expect(store.getState().activeSpace()?.color).toBe("#3ddc97");
    fireEvent.change(hex, { target: { value: "#123ABC" } });
    await waitFor(() => expect(store.getState().activeSpace()?.color).toBe("#123abc"));
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "p2" } });
    await waitFor(() => expect(store.getState().activeSpace()?.profileId).toBe("p2"));
  });

  it("delete requires confirmation, then removes the space; the page says the space is gone", async () => {
    const { store, api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: /Delete space/ }));
    expect(api.calls.some((c) => c.startsWith("deleteSpace"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["s2"]));
    expect(store.getState().activeSpaceId).toBe("s2");
    // No sheet to close any more: the pane outlives the click only long enough to say why it is empty.
    expect(screen.getByText("This space no longer exists.")).toBeInTheDocument();
  });

  it("the rail moves between all seven tabs — General, Memory, Skills, Connections, Sessions, Tasks, History", async () => {
    await mount();
    // General is the default, so every sheet-era flow above lands where it always did.
    expect(screen.getByRole("textbox", { name: "Space name" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    expect(await screen.findByText(/isolates this space's Claude sessions/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Space name" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
    expect(await screen.findByText(/stored in plain text in Realm's database/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByRole("textbox", { name: "Space memory document" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));
    expect(screen.getByText(/No sessions in this space yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Tasks" }));
    expect(screen.getByText(/Nothing has been dispatched here yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "General" }));
    expect(screen.getByRole("textbox", { name: "Space name" })).toBeInTheDocument();
  });
});

/** W1 split the checkout out of the session and W2 made worktrees; this list is where that split is
 *  finally visible, and the only route to removing a worktree after its session is gone (W3). */
describe("the space's checkouts", () => {
  const envs: Environment[] = [
    { id: "envP", spaceId: "s1", path: "/tmp/versed", branch: "main", kind: "primary", portBlockStart: 41000, createdAt: 0, updatedAt: 0 },
    { id: "envW", spaceId: "s1", path: "/tmp/worktrees/s1/fix-login", branch: "realm/fix-login", kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 },
  ];

  async function openGeneral(extra: FakeData = {}) {
    return mount({
      environments: { s1: envs },
      sessions: [session("se1", "s1", { environmentId: "envW" }), session("se2", "s1", { environmentId: "envW" })],
      worktreeStatus: { envW: { environmentId: "envW", path: "/tmp/worktrees/s1/fix-login", branch: "realm/fix-login", present: true, dirtyFiles: 0, unpushedCommits: 0, removable: true, blockedBy: null } },
      ...extra,
    });
  }

  it("names each checkout, its kind, its reserved port range and who is in it", async () => {
    await openGeneral();
    const worktree = screen.getByText("realm/fix-login").closest(".env-row") as HTMLElement;
    expect(within(worktree).getByText("Worktree")).toBeInTheDocument();
    expect(within(worktree).getByText("/tmp/worktrees/s1/fix-login")).toBeInTheDocument();
    // A RANGE Realm holds — never a claim about what is listening on it.
    expect(within(worktree).getByText("ports 41020–41029 reserved")).toBeInTheDocument();
    expect(within(worktree).getByText("2 sessions")).toBeInTheDocument();
    const primary = screen.getByText("main").closest(".env-row") as HTMLElement;
    expect(within(primary).getByText("Space folder")).toBeInTheDocument();
    expect(within(primary).getByText("no sessions")).toBeInTheDocument();
  });

  it("offers removal only for the worktree, never for the space's own folder", async () => {
    const { api, store } = await openGeneral();
    const primary = screen.getByText("main").closest(".env-row") as HTMLElement;
    expect(within(primary).queryByRole("button", { name: "Remove…" })).toBeNull();
    const worktree = screen.getByText("realm/fix-login").closest(".env-row") as HTMLElement;
    fireEvent.click(within(worktree).getByRole("button", { name: "Remove…" }));
    // The button opens the confirm (App renders it), having first read what removal would cost.
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "remove-worktree", environmentId: "envW" }));
    expect(api.calls).toContain("worktreeStatus:envW");
  });

  it("says a brand-new space has no checkout on record rather than rendering an empty list", async () => {
    // environments.list is empty until a space actually runs something — the primary row is lazy.
    await openGeneral({ environments: {} });
    expect(screen.getByText(/has not run anything yet/)).toBeInTheDocument();
  });
});

/* ——— New in Plan 12 W3: the page's header and its Sessions / History / Memory tabs. ——— */

describe("the page header", () => {
  it("shows the live space name, the session count, and a working New session", async () => {
    const { store, api } = await mount({ sessions: [session("se1", "s1"), session("se2", "s1")] });
    expect(screen.getByRole("heading", { level: 1, name: "Versed" })).toBeInTheDocument();
    // A foreign session in the map (the transient state around a space switch): counting it is the
    // cross-space mutant. The store normally holds only the active space's sessions, so inject it.
    act(() => store.setState({ sessions: { ...store.getState().sessions, se9: session("se9", "s2") } }));
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New session/ }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("createSession:"))).toBe(true));
    expect(Object.values(store.getState().sessions).filter((s) => s.spaceId === "s1")).toHaveLength(3);
  });
});

describe("the Sessions tab", () => {
  const data: FakeData = {
    items: { s1: [
      item("it1", "s1", { kind: "session", title: "Fix login", refId: "se1" }),
      item("it2", "s1", { kind: "session", title: "Write docs", refId: "se2" }),
    ] },
    sessions: [
      session("se1", "s1", { title: "Fix login", status: "running", createdAt: 2000 }),
      session("se2", "s1", { title: "Write docs", status: "idle", createdAt: 1000 }),
    ],
  };

  it("lists only THIS space's sessions, newest first, with their status dots", async () => {
    const { store } = await mount(data);
    // A foreign session in the map (the transient state around a space switch) must never render
    // on this space's page — the named cross-space mutant. Injected because the store normally
    // scopes `sessions` to the active space.
    act(() => store.setState({ sessions: { ...store.getState().sessions, se9: session("se9", "s2", { title: "Someone else's homework", createdAt: 3000 }) } }));
    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));
    const rows = screen.getAllByRole("button", { name: /Fix login|Write docs|homework/ });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Fix login — running", "Write docs — idle"]);
    expect(rows[0]!.querySelector(".status-dot")).toHaveAttribute("data-status", "running");
  });

  it("a row opens THAT session's pane — the item matched by refId, never by position", async () => {
    const { store } = await mount(data);
    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));
    // Click the SECOND row: an off-by-one (or an open of whatever is first) fails the leaf check.
    fireEvent.click(screen.getByRole("button", { name: "Write docs — idle" }));
    await waitFor(() => expect(JSON.stringify(store.getState().layout)).toContain('"it2"'));
    expect(store.getState().focusedLeafId).not.toBeNull();
    expect(JSON.stringify(store.getState().layout)).not.toContain('"it1"');
  });
});

/** Plan 13 W2: a lens over dispatched-origin sessions — no new runtime, and hard space scoping. */
describe("the Tasks tab", () => {
  const wtEnv: Environment = { id: "envW", spaceId: "s1", path: "/wt", branch: "realm/wt", kind: "worktree", portBlockStart: null, createdAt: 0, updatedAt: 0 };
  const data: FakeData = {
    items: { s1: [
      item("it1", "s1", { kind: "session", title: "Fix login", refId: "se1" }),
      item("it2", "s1", { kind: "session", title: "Agent: parse", refId: "se2" }),
      item("it3", "s1", { kind: "session", title: "Dispatched task", refId: "se3" }),
    ] },
    environments: { s1: [wtEnv] },
    sessions: [
      session("se1", "s1", { title: "Fix login", status: "running", createdAt: 3000 }), // NOT dispatched — a lens, not a session list
      session("se2", "s1", { title: "Agent: parse", status: "running", createdAt: 2000, environmentId: "envW", cwd: "/wt",
        dispatchedBy: { sessionId: "se1", kind: "agent_run" } }),
      session("se3", "s1", { title: "Dispatched task", status: "idle", createdAt: 1000, updatedAt: 5000,
        dispatchedBy: { sessionId: null, kind: "user-dispatch" } }),
    ],
  };

  it("lists ONLY dispatched-origin sessions of THIS space — a foreign space's dispatched session never renders", async () => {
    const { store } = await mount(data);
    // The named mutant: the lens listing another space's sessions. Injected past the store's own
    // active-space scoping, exactly like the Sessions tab's cross-space test.
    act(() => store.setState({ sessions: { ...store.getState().sessions,
      se9: session("se9", "s2", { title: "Foreign dispatch", createdAt: 9000, dispatchedBy: { sessionId: null, kind: "user-dispatch" } }) } }));
    fireEvent.click(screen.getByRole("radio", { name: "Tasks" }));
    expect(screen.getByText("Agent: parse")).toBeInTheDocument();
    expect(screen.getByText("Dispatched task")).toBeInTheDocument();
    expect(screen.queryByText("Fix login")).toBeNull();        // undelegated sessions stay on Sessions
    expect(screen.queryByText("Foreign dispatch")).toBeNull(); // the cross-space mutant
  });

  it("rows carry origin, environment, started/settled and the status dot — settled only once settled", async () => {
    await mount(data);
    fireEvent.click(screen.getByRole("radio", { name: "Tasks" }));
    const agentRow = screen.getByText("Agent: parse").closest("button")!;
    expect(agentRow.getAttribute("aria-label")).toContain("Delegated via agent_run");
    expect(agentRow.textContent).toContain("realm/wt"); // the worktree it runs in
    expect(agentRow.textContent).toContain("started");
    expect(agentRow.textContent).not.toContain("settled"); // still running — no settle time invented
    expect(agentRow.querySelector(".status-dot")).toHaveAttribute("data-status", "running");
    const userRow = screen.getByText("Dispatched task").closest("button")!;
    expect(userRow.getAttribute("aria-label")).toContain("Dispatched");
    expect(userRow.textContent).toContain("settled");
    expect(userRow.querySelector(".status-dot")).toHaveAttribute("data-status", "idle");
  });

  it("the agent origin links its parent; the row itself jumps to the dispatched session", async () => {
    const { store } = await mount(data);
    fireEvent.click(screen.getByRole("radio", { name: "Tasks" }));
    fireEvent.click(screen.getByText("from Fix login"));
    await waitFor(() => expect(JSON.stringify(store.getState().layout)).toContain('"it1"')); // the PARENT's item
    fireEvent.click(screen.getByText("Dispatched task"));
    await waitFor(() => expect(JSON.stringify(store.getState().layout)).toContain('"it3"'));
  });
});

describe("the History tab", () => {
  const envs: Environment[] = [
    { id: "envA", spaceId: "s1", path: "/tmp/versed", branch: "main", kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 },
    { id: "envB", spaceId: "s1", path: "/tmp/wt", branch: "realm/fix", kind: "worktree", portBlockStart: null, createdAt: 0, updatedAt: 0 },
    { id: "envX", spaceId: "s2", path: "/tmp/other", branch: "other", kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 },
  ];

  it("unions checkpoints across the space's environments, newest first — never another space's", async () => {
    const { store, api } = await mount({
      environments: { s1: [envs[0]!, envs[1]!], s2: [envs[2]!] },
      checkpoints: {
        envA: [checkpoint("cpA", "envA", { label: "older turn", createdAt: 1000 })],
        envB: [checkpoint("cpB", "envB", { label: "newer turn", createdAt: 2000 })],
        envX: [checkpoint("cpX", "envX", { label: "foreign turn", createdAt: 3000 })],
      },
    });
    // A foreign environment in the map (the transient state around a space switch): asking for — or
    // rendering — ITS checkpoints is the named cross-space mutant. Injected because the store
    // normally scopes `environments` to the active space.
    act(() => store.setState({
      environments: { ...store.getState().environments, envX: envs[2]! },
      checkpoints: { ...store.getState().checkpoints, envX: [checkpoint("cpX", "envX", { label: "foreign turn", createdAt: 3000 })] },
    }));
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    await screen.findByText("newer turn");
    const labels = screen.getAllByText(/turn$/).map((el) => el.textContent);
    expect(labels).toEqual(["newer turn", "older turn"]);
    // Only this space's environments were asked, ever.
    expect(api.calls.filter((c) => c.startsWith("listCheckpoints"))).toEqual(
      expect.arrayContaining(["listCheckpoints:envA|*", "listCheckpoints:envB|*"]));
    expect(api.calls.some((c) => c.startsWith("listCheckpoints:envX"))).toBe(false);
  });

  it("a row opens the checkpoints sheet for that row's OWN environment", async () => {
    const { store } = await mount({
      environments: { s1: [envs[0]!, envs[1]!] },
      checkpoints: { envA: [checkpoint("cpA", "envA", { label: "a turn", createdAt: 1000 })], envB: [] },
    });
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: /a turn — open checkpoints/ }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "checkpoints", environmentId: "envA", sessionId: null }));
  });

  it("the empty state names both sources — and the old not-recorded-durably apology is gone (W1)", async () => {
    await mount({ environments: { s1: [envs[0]!] }, checkpoints: { envA: [] } });
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    expect(await screen.findByText(/records every commit shipped/)).toBeInTheDocument();
    expect(screen.queryByText(/not recorded durably/)).toBeNull();
  });

  /* ——— Plan 14 W1: ships interleave with checkpoints. ——— */

  it("interleaves ships with checkpoints by time — dropping either source is the named mutant", async () => {
    await mount({
      environments: { s1: [envs[0]!] },
      checkpoints: { envA: [
        checkpoint("cpA", "envA", { label: "older turn", createdAt: 1000 }),
        checkpoint("cpB", "envA", { label: "newest turn", createdAt: 3000 }),
      ] },
      ships: { s1: [shipRow("sh1", "s1", { subject: "the middle ship", createdAt: 2000 })] },
    });
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    await screen.findByText("the middle ship");
    const titles = [...document.querySelectorAll(".page-row-title")].map((el) => el.textContent);
    expect(titles).toEqual(["newest turn", "the middle ship", "older turn"]);
  });

  it("a ship row shows sha, branch, its ACTUAL push state and links the PR when there is one", async () => {
    await mount({
      environments: { s1: [envs[0]!] }, checkpoints: { envA: [] },
      ships: { s1: [
        shipRow("sh1", "s1", { subject: "landed", sha: "abcdef1234", branch: "main", pushState: "pushed", prUrl: "https://github.com/acme/w/pull/9", createdAt: 2000 }),
        shipRow("sh2", "s1", { subject: "stuck", sha: "1234abcdef", branch: "realm/fix", pushState: "rejected", prUrl: null, createdAt: 1000 }),
      ] },
    });
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    const landed = (await screen.findByText("landed")).closest(".ship-row") as HTMLElement;
    expect(within(landed).getByText("abcdef1")).toBeInTheDocument();
    expect(within(landed).getByText(/main/)).toBeInTheDocument();
    expect(within(landed).getByText("pushed")).toBeInTheDocument();
    expect(within(landed).getByRole("link", { name: /PR/ })).toHaveAttribute("href", "https://github.com/acme/w/pull/9");
    // A rejected push says so — a ship row may never claim more than the push actually did.
    const stuck = screen.getByText("stuck").closest(".ship-row") as HTMLElement;
    expect(within(stuck).getByText("push rejected")).toBeInTheDocument();
    expect(within(stuck).queryByText(/^pushed$/)).toBeNull();
    expect(within(stuck).queryByRole("link")).toBeNull();
  });

  it("lists only THIS space's ships and asks only for them", async () => {
    const { api } = await mount({
      environments: { s1: [envs[0]!] }, checkpoints: { envA: [] },
      ships: { s1: [shipRow("sh1", "s1", { subject: "ours" })], s2: [shipRow("sh2", "s2", { subject: "theirs" })] },
    });
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    await screen.findByText("ours");
    expect(screen.queryByText("theirs")).toBeNull();
    expect(api.calls.filter((c) => c.startsWith("listShips"))).toEqual(["listShips:s1"]);
  });
});

describe("the Memory tab (standing-instruction framing)", () => {
  it("frames the doc with the reads-before-it-starts copy and no fake agent-learned section", async () => {
    await mount({ memoryDocs: { s1: "use pnpm, never npm" } });
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByText(/Every session in this space reads this before it starts/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Space memory document" })).toHaveValue("use pnpm, never npm");
    // A non-empty doc gets no empty-state CTA.
    expect(screen.queryByRole("button", { name: "Write a standing instruction" })).toBeNull();
  });

  it("an empty doc offers 'Write a standing instruction', which focuses the editor — and saving writes THIS space's doc", async () => {
    const { api } = await mount({ memoryDocs: { s1: "", s2: "another space's memory" } });
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    const cta = await screen.findByRole("button", { name: "Write a standing instruction" });
    fireEvent.click(cta);
    const doc = screen.getByRole("textbox", { name: "Space memory document" });
    expect(doc).toHaveFocus();
    fireEvent.change(doc, { target: { value: "always run the linter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    // The named mutant: the CTA/save path writing to the wrong space's document.
    await waitFor(() => expect(api.data.memoryDocs.s1).toBe("always run the linter"));
    expect(api.data.memoryDocs.s2).toBe("another space's memory");
  });
});

describe("per-space tab isolation", () => {
  it("two spaces' pages never share a tab selection — a space switch cannot carry one space's tab over", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    expect(store.getState().spacePageTab.s1).toBe("skills");
    // The OTHER space's page state is untouched: its page would open on General.
    expect(store.getState().spacePageTab.s2 ?? "general").toBe("general");
  });
});

import { describe, expect, it } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { ProfilePage } from "./ProfilePage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, fakeMemoryRepo, item, mcpServer, profile, session, skillRow, space, type FakeData } from "../../state/store.test-fakes";

/** The page pane as PaneHost mounts it: a destination item whose refId is the kind's sentinel
 *  (Plan 14 W2) — the PROFILE is derived live from the item's space, never stored. */
const pageItem = (spaceId: string) =>
  item(`pg-profile-${spaceId}`, spaceId, { kind: "profile-page", title: "Profile", refId: PAGE_REF_IDS["profile-page"] });

/* Defaults (fakeApi): profiles p1 "Work" / p2 "School"; spaces s1 "Versed" (p1) / s2 "Homework" (p2). */
async function mount(overrides: FakeData = {}, spaceId = "s1") {
  const api = fakeApi(overrides); const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><ProfilePage item={pageItem(spaceId)} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("ProfilePage · header", () => {
  it("names the vantage space's profile and lists THAT profile's spaces as jump chips", async () => {
    const { store } = await mount({
      spaces: [space("s1", "p1", "Versed"), space("s3", "p1", "Side project"), space("s2", "p2", "Homework")],
    });
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
    const chips = within(screen.getByLabelText("Spaces of Work"));
    expect(chips.getByRole("button", { name: /Versed/ })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: /Side project/ })).toBeInTheDocument();
    // Another profile's space is not this profile's — no chip.
    expect(chips.queryByRole("button", { name: /Homework/ })).toBeNull();
    fireEvent.click(chips.getByRole("button", { name: /Side project/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
  });

  it("the spaces are a second list IN the rail, under its own heading, beside the sections", async () => {
    /* THE MUTANT: leave them as a band over the title. They are navigation, and above the head they
       read as decoration on the page's name rather than as the other half of the rail's list. */
    const { container } = await mount();
    const spaces = screen.getByLabelText("Spaces of Work");
    expect(container.querySelector(".page-rail")!.contains(spaces)).toBe(true);
    expect(container.querySelector(".page > .profile-spaces")).toBeNull();
    // Its own heading, not a rule: the rail holds two lists and one of them needs saying which.
    expect(within(spaces).getByText("Spaces")).toBeInTheDocument();
    // Buttons, not radios — the sections are a choice of what this page shows, a space is somewhere
    // to go, and a space wearing `role=radio` would promise the rail keeps one of them lit.
    expect(within(spaces).queryByRole("radio")).toBeNull();
    expect(within(spaces).getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("derives the profile LIVE from the item's space — a space moved between profiles moves the page's subject", async () => {
    const { store } = await mount();
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
    // The space changes profile under the open page: the page must follow, or it would keep showing
    // (and editing) a profile its space has left — the named W2 mutant's sibling.
    act(() => store.setState({ spaces: store.getState().spaces.map((sp) => (sp.id === "s1" ? { ...sp, profileId: "p2" } : sp)) }));
    expect(screen.getByRole("heading", { name: "School" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Work" })).toBeNull();
  });

  it("the rail moves between General, Skills, Connections and Memory — General first", async () => {
    await mount({ profileMemoryDocs: { p1: "profile-wide context" } });
    expect(screen.getByRole("radio", { name: "General" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Profile name" })).toHaveValue("Work");
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    expect(await screen.findByText(/Skills here are seen by every space of Work/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
    expect(await screen.findByText(/stored in plain text in Realm's database/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByRole("textbox", { name: "Work memory document" })).toHaveValue("profile-wide context");
  });
});

describe("ProfilePage · Skills", () => {
  const rows = [
    skillRow("mine", { scope: { kind: "profile", profileId: "p1" } }),
    skillRow("foreign", { scope: { kind: "profile", profileId: "p2" } }),
    skillRow("legacy", { scope: { kind: "space", spaceId: null } }),
    skillRow("space-only", { scope: { kind: "space", spaceId: "s1" } }),
  ] as const;

  it("lists the profile's OWN skills and the pre-scoping rows — never another profile's, never a space's", async () => {
    await mount({ skills: { s1: [...rows] } });
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    const own = within(await screen.findByText("Work's skills").then((el) => el.closest(".field") as HTMLElement));
    expect(own.getByText("mine")).toBeInTheDocument();
    // The named W2 mutant: another profile's item surfacing (editable or at all) on this page.
    expect(screen.queryByText("foreign")).toBeNull();
    // A space's own row belongs to that space's page, not here.
    expect(screen.queryByText("space-only")).toBeNull();
    const everywhere = within(screen.getByText("Everywhere").closest(".field") as HTMLElement);
    expect(everywhere.getByText("legacy")).toBeInTheDocument();
    /* Read-only: nothing here CHANGES the row — no move, no switch, just the note pointing at its
       space of use. The name is a button, and deliberately: it opens the skill's page, which is
       reading rather than editing, and a skill has to open the same way from every list. */
    expect(everywhere.getByRole("button", { name: "legacy" })).toBeInTheDocument();
    expect(everywhere.queryAllByRole("button").map((b) => b.textContent)).toEqual(["legacy"]);
    expect(everywhere.queryByRole("switch")).toBeNull();
    expect(everywhere.getByText(/manage it from a space page/)).toBeInTheDocument();
  });

  it("demote ('Keep in one space…') confirms, names the vantage space, and fires DEMOTE — never promote", async () => {
    const { api } = await mount({ skills: { s1: [...rows] } });
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep in one space…" }));
    // Nothing moved yet — the confirm is the gate.
    expect(api.calls.some((c) => c.startsWith("demoteSkill"))).toBe(false);
    expect(screen.getByText(/Keep “mine” in Versed only\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move to this space" }));
    await waitFor(() => expect(api.calls).toContain("demoteSkill:s1:mine"));
    // The named mutant: the demote confirm firing promote.
    expect(api.calls.some((c) => c.startsWith("promoteSkill"))).toBe(false);
  });
});

describe("ProfilePage · Connections", () => {
  // A factory, not a shared constant: the fake mutates its rows in place, and one test's rename
  // must not leak into the next.
  const servers = () => [
    mcpServer("m-own", { name: "ours", scope: { kind: "profile", profileId: "p1" } }),
    mcpServer("m-foreign", { name: "theirs", scope: { kind: "profile", profileId: "p2" } }),
    mcpServer("m-legacy", { name: "old-timer", scope: { kind: "space", spaceId: null } }),
  ];

  it("lists the profile's own servers with a FULL bannerless editor; pre-scoping rows are read-only", async () => {
    await mount({ mcpServers: servers() });
    fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
    const ownRow = (await screen.findByText("ours")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(ownRow).getByRole("button", { name: "Edit" }));
    // The full editor, worn WITHOUT the defining-scope banner: this page IS the defining scope.
    expect(within(ownRow).getByRole("textbox", { name: "Server name" })).toHaveValue("ours");
    expect(ownRow.querySelector(".scope-note")).toBeNull();
    // The named W2 mutant: another profile's server showing up (with or without an editor).
    expect(screen.queryByText("theirs")).toBeNull();
    // Pre-scoping: listed, note, no actions.
    const legacyRow = screen.getByText("old-timer").closest(".mcp-row") as HTMLElement;
    expect(within(legacyRow).queryByRole("button")).toBeNull();
  });

  it("saving the editor updates the one shared row", async () => {
    const { api } = await mount({ mcpServers: servers() });
    fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
    const ownRow = (await screen.findByText("ours")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(ownRow).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(ownRow).getByRole("textbox", { name: "Server name" }), { target: { value: "renamed" } });
    fireEvent.click(within(ownRow).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.mcpWrites.some((w) => "id" in w && w.id === "m-own" && w.name === "renamed")).toBe(true));
  });

  it("removal names its whole-profile reach and demote fires DEMOTE — never promote", async () => {
    const { api } = await mount({ mcpServers: servers() });
    fireEvent.click(screen.getByRole("radio", { name: "Connections" }));
    const ownRow = (await screen.findByText("ours")).closest(".mcp-row") as HTMLElement;
    fireEvent.click(within(ownRow).getByRole("button", { name: "Remove…" }));
    expect(within(ownRow).getByText("Removes it for every space of Work.")).toBeInTheDocument();
    fireEvent.click(within(ownRow).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(ownRow).getByRole("button", { name: "Keep in one space…" }));
    fireEvent.click(within(ownRow).getByRole("button", { name: "Move to this space" }));
    await waitFor(() => expect(api.calls).toContain("demoteMcpServer:s1:m-own"));
    expect(api.calls.some((c) => c.startsWith("promoteMcpServer"))).toBe(false);
    expect(api.calls.some((c) => c.startsWith("removeMcpServer"))).toBe(false);
  });
});

describe("ProfilePage · Memory", () => {
  it("edits the PROFILE doc in full — the save lands on this page's profile, no other", async () => {
    const { api } = await mount({ profileMemoryDocs: { p1: "old", p2: "other profile's doc" } });
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    const doc = await screen.findByRole("textbox", { name: "Work memory document" });
    expect(doc).toHaveValue("old");
    // The reach is page copy, not a banner: this page IS the defining scope.
    expect(screen.getByText(/every new session in every space of Work/)).toBeInTheDocument();
    fireEvent.change(doc, { target: { value: "new profile-wide rule" } });
    fireEvent.blur(doc);
    await waitFor(() => expect(api.data.profileMemoryDocs.p1).toBe("new profile-wide rule"));
    expect(api.data.profileMemoryDocs.p2).toBe("other profile's doc");
  });
});

describe("ProfilePage · Memory repo", () => {
  const openMemory = () => fireEvent.click(screen.getByRole("radio", { name: "Memory" }));

  it("offers Create and Attach when the profile has none, and Create makes this profile's", async () => {
    const { api } = await mount({ memoryRepoLogs: { "profile:p1": [{ sha: "a1b2c3d4", subject: "Create memory repo", at: Date.now() - 60_000 }] } });
    openMemory();
    expect(await screen.findByText("No memory repo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach existing…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    // THE MUTANT: create for the vantage space's id, or for another profile — the repo lands on the wrong owner.
    await waitFor(() => expect(api.calls).toContain("createMemoryRepo:profile:p1"));
    expect(await screen.findByText("/realm-home/memory/repos/profile-p1")).toBeInTheDocument();
    expect(screen.getByText("Last saved")).toBeInTheDocument();
    expect(screen.getByText(/^Just now: Create memory repo$/)).toBeInTheDocument();
    expect(screen.getByText("Nowhere. It stays on this Mac.")).toBeInTheDocument();
    expect(screen.getByText("Recent memories")).toBeInTheDocument();
  });

  it("attaches the picked folder, and says the server's refusal when it is not a memory repo", async () => {
    const refusal = "/tmp/picked-repo is not a memory repo: it has no MEMORY.md at its top";
    const { api, store } = await mount({ memoryRepoAttachError: refusal });
    openMemory();
    fireEvent.click(await screen.findByRole("button", { name: "Attach existing…" }));
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toContain(refusal));
    expect(api.calls).toContain("attachMemoryRepo:profile:p1:/tmp/picked-repo");
    expect(screen.getByText("No memory repo")).toBeInTheDocument();
    api.data.memoryRepoAttachError = "";
    fireEvent.click(screen.getByRole("button", { name: "Attach existing…" }));
    expect(await screen.findByText("/tmp/picked-repo")).toBeInTheDocument();
  });

  it("says in words why agents cannot save, toned by how bad it is", async () => {
    const dirty = fakeMemoryRepo({ clean: false, uncommitted: ["draft.md"], reason: "1 uncommitted change — agents save again once the repo is clean" });
    const { store } = await mount({ memoryRepos: { p1: dirty } });
    openMemory();
    // THE MUTANT: the status ignores `clean` — it reads "Last saved" while every save is refused.
    expect(await screen.findByText("Saving paused")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("1 uncommitted change — agents save again once the repo is clean.")).toBeInTheDocument();
    act(() => store.setState({ profileMemoryRepo: { p1: fakeMemoryRepo({ valid: false, reason: "the folder is gone" }) } }));
    expect(screen.getByText("Not a memory repo")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByText("The folder is gone.")).toBeInTheDocument();
    // Saving goes on past a file Claude wrote that cannot be memory, and the row names it.
    const held = "spaces/realm/keys.md stays uncommitted: it looks like it holds an API key, and memory never holds credentials. Edit or delete it";
    act(() => store.setState({ profileMemoryRepo: { p1: fakeMemoryRepo({ clean: true, uncommitted: ["spaces/realm/keys.md"], reason: held }) } }));
    expect(screen.getByText("File left out")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText(`${held.charAt(0).toUpperCase()}${held.slice(1)}.`)).toBeInTheDocument();
  });

  it("detaches this profile's repo and leaves the folder to the user", async () => {
    const { api } = await mount({ memoryRepos: { p1: fakeMemoryRepo() } });
    openMemory();
    const detach = await screen.findByRole("button", { name: "Detach" });
    expect(detach).toHaveAttribute("title", expect.stringContaining("The folder and its history stay where they are"));
    // A profile's repo is made by default, so the consequence said before the click is that it is not made again.
    expect(detach).toHaveAttribute("title", expect.stringContaining("Realm does not make another"));
    fireEvent.click(detach);
    await waitFor(() => expect(api.calls).toContain("detachMemoryRepo:profile:p1"));
    expect(await screen.findByText("No memory repo")).toBeInTheDocument();
    expect(screen.getByText(/^Memory is off for this profile/)).toBeInTheDocument();
  });
});

describe("ProfilePage · Memory repo sync", () => {
  const openMemory = () => fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  const REMOTE = "/Users/me/memory.git";

  it("adds a remote from the row, and says the repo stays on this Mac until then", async () => {
    const { api } = await mount({ memoryRepos: { p1: fakeMemoryRepo() } });
    openMemory();
    expect(await screen.findByText("Nowhere. It stays on this Mac.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add remote…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Remote URL" }), { target: { value: ` ${REMOTE} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls).toContain(`setMemoryRepoRemote:profile:p1:${REMOTE}`));
    expect(await screen.findByText("Not synced. Realm only syncs memory to a private remote.")).toBeInTheDocument();
  });

  it("turns sync on for a remote Realm cannot check only once the user confirms it is private", async () => {
    const { api } = await mount({ memoryRepos: { p1: fakeMemoryRepo({ remote: REMOTE }) } });
    openMemory();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on sync…" }));
    expect(await screen.findByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText(/Turn sync on only for a private repository you own\./)).toBeInTheDocument();
    const on = screen.getByRole("button", { name: "Turn on sync" });
    // THE MUTANT: leave the button enabled before the box is ticked — one click sends memory to a
    // remote nobody said is private.
    expect(on).toBeDisabled();
    const box = screen.getByRole("checkbox", { name: "I confirm this remote is private" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(on);
    await waitFor(() => expect(api.calls).toContain("setMemoryRepoSync:profile:p1:true:true"));
    expect(await screen.findByText(/Up to date/)).toBeInTheDocument();
  });

  it("offers no way to sync to a remote GitHub says is public, and needs no box for a private one", async () => {
    const url = "git@github.com:me/memory.git";
    const { api, store } = await mount({
      memoryRepos: { p1: fakeMemoryRepo({ remote: url }) },
      memoryRemoteChecks: { "profile:p1": { remote: url, verdict: "public", detail: "GitHub says me/memory is public" } },
    });
    openMemory();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on sync…" }));
    expect(await screen.findByText("GitHub says me/memory is public. Memory never syncs to a public remote.")).toBeInTheDocument();
    expect(screen.getByText("Public")).toHaveAttribute("data-tone", "danger");
    expect(screen.queryByRole("button", { name: "Turn on sync" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    api.data.memoryRemoteChecks["profile:p1"] = { remote: url, verdict: "private", detail: "GitHub says me/memory is private" };
    fireEvent.click(await screen.findByRole("button", { name: "Turn on sync…" }));
    expect(await screen.findByText(/^GitHub says me\/memory is private\./)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on sync" }));
    await waitFor(() => expect(api.calls).toContain("setMemoryRepoSync:profile:p1:true:false"));
    expect(store.getState().profileMemoryRepo.p1?.pushEnabled).toBe(true);
  });

  it("says saves are waiting when the network was down, and Retry now syncs", async () => {
    const { api } = await mount({ memoryRepos: { p1: fakeMemoryRepo({ remote: REMOTE, pushEnabled: true, sync: "queued", ahead: 2, syncError: `'${REMOTE}' does not appear to be a git repository` }) } });
    openMemory();
    // git's own words, with the URL already on the line above said as "the remote".
    const text = await screen.findByText("2 saves waiting to push — the remote does not appear to be a git repository. Realm tries again on the next save.");
    expect(text).toHaveAttribute("data-tone", "warning");
    // A queued push never pauses saving: the status row still says when it last saved.
    expect(screen.getByText("Last saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(api.calls).toContain("syncMemoryRepo:profile:p1"));
  });

  it("pauses saving when the repo diverged, and hands the user the command to resolve it in Terminal", async () => {
    const path = "/Users/me/Agent Memory";
    await mount({ memoryRepos: { p1: fakeMemoryRepo({
      path, remote: REMOTE, pushEnabled: true, sync: "diverged", ahead: 1, behind: 2,
      reason: "this repo and its remote have both changed since they last matched — Realm never merges memory, so saving is paused until you resolve it in Terminal",
    }) } });
    openMemory();
    // THE MUTANT: the status reads only `clean` — a diverged repo says "Last saved" while every save is refused.
    expect(await screen.findByText("Saving paused")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("It and this repo have both changed since they last matched. Realm never merges memory.")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByText("Resolve in Terminal")).toBeInTheDocument();
    expect(screen.getByText("cd '/Users/me/Agent Memory' && git pull --no-rebase")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });
});

describe("ProfilePage · Claude memory", () => {
  const openMemory = () => fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  const ran = { imported: 0, updated: 0, removed: 0, total: 0, unmatched: [], chosen: [], skipped: [], error: null, sha: null, at: Date.now() - 60_000 };
  const spaces = [space("s1", "p1", "Versed"), space("s3", "p1", "Side project"), space("s2", "p2", "Homework")];
  const big = { project: "-Users-me-code-stora-platform", path: "/Users/me/code/stora-platform", files: 80, reason: "no space works in that folder" };
  const small = { project: "-Users-me-code-clubology", path: null, files: 1, reason: "Versed and Side project both work there" };

  it("says what of Claude's own memory is in the repo, lists what stays out, and checks again on asking", async () => {
    const { api } = await mount({
      memoryRepos: { p1: fakeMemoryRepo() },
      claudeBackfills: { p1: {
        last: { ...ran, total: 12, skipped: [{ file: "/Users/me/.claude/projects/-Users-me-code-realm/memory/keys.md", reason: "it looks like it holds an API key, and memory never holds credentials" }] },
        next: { ...ran, total: 13, imported: 1, sha: "f00dfeed", at: Date.now() },
      } },
    });
    openMemory();
    expect(await screen.findByText("12 files of Claude's own memory are in this repo, each in the folder of the space it was kept for.")).toBeInTheDocument();
    expect(screen.getByText("1 file stays in Claude's folder.")).toBeInTheDocument();
    expect(screen.getByText("memory/keys.md")).toBeInTheDocument();
    // Read on its own; it runs only when asked here (or by itself on the server).
    expect(api.calls).not.toContain("claudeBackfill:p1:true");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(api.calls).toContain("claudeBackfill:p1:true"));
    expect(await screen.findByText("13 files of Claude's own memory are in this repo, each in the folder of the space it was kept for. The last check brought in 1 new file.")).toBeInTheDocument();
    // Nothing waits and nothing new stays out: no list at all.
    expect(screen.queryByText("Claude projects")).toBeNull();
  });

  it("gives each project no single space claims a select of this profile's spaces, biggest first with its size", async () => {
    const { api, container } = await mount({
      spaces, memoryRepos: { p1: fakeMemoryRepo() },
      claudeBackfills: { p1: {
        last: { ...ran, total: 3, unmatched: [big, small] },
        placed: { ...ran, total: 83, imported: 80, sha: "f00dfeed", at: Date.now(), unmatched: [small], chosen: [{ project: big.project, path: big.path, files: 80, spaceId: "s3" }] },
      } },
    });
    openMemory();
    expect(await screen.findByText("2 Claude projects match no single space: choose where each one's memory goes.")).toBeInTheDocument();
    const rows = [...container.querySelectorAll(".memory-claude-project")];
    // The folder a project names, by its last two parts; Claude's own name where the folder is gone.
    expect(rows.map((r) => r.querySelector(".memory-repo-log-subject")!.textContent)).toEqual(["code/stora-platform", "-Users-me-code-clubology"]);
    expect(rows.map((r) => r.querySelector(".memory-claude-project-files")!.textContent)).toEqual(["80 files", "1 file"]);
    expect(within(rows[1] as HTMLElement).getByText("Versed and Side project both work there")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Where the memory of code/stora-platform goes" }) as HTMLSelectElement;
    // Nothing is chosen for the person: the select starts on the question.
    expect(select.value).toBe("");
    // Only this profile's spaces, then the way out.
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose a space…", "Versed", "Side project", "Leave out"]);
    fireEvent.change(select, { target: { value: "s3" } });
    await waitFor(() => expect(api.calls).toContain("setClaudeProject:p1:-Users-me-code-stora-platform:s3"));
    expect(await screen.findByText("83 files of Claude's own memory are in this repo, each in the folder of the space it was kept for. The last check brought in 80 new files.")).toBeInTheDocument();
    expect(screen.getByText("1 Claude project matches no single space: choose where its memory goes.")).toBeInTheDocument();
    // The placed project keeps its select, on the space chosen, so the choice can be changed.
    expect((screen.getByRole("combobox", { name: "Where the memory of code/stora-platform goes" }) as HTMLSelectElement).value).toBe("s3");
  });

  it("leaves a project out on asking, says so on its select, and says what came out of the space it was in", async () => {
    const { api } = await mount({
      spaces, memoryRepos: { p1: fakeMemoryRepo() },
      claudeBackfills: { p1: {
        last: { ...ran, total: 1, chosen: [{ project: small.project, path: null, files: 1, spaceId: "s1" }] },
        placed: { ...ran, removed: 1, sha: "f00dfeed", chosen: [{ project: small.project, path: null, files: 1, spaceId: null }] },
      } },
    });
    openMemory();
    fireEvent.change(await screen.findByRole("combobox", { name: "Where the memory of -Users-me-code-clubology goes" }), { target: { value: "skip" } });
    await waitFor(() => expect(api.calls).toContain("setClaudeProject:p1:-Users-me-code-clubology:skip"));
    expect(await screen.findByText("None of this profile's spaces has memory Claude kept outside Realm. It took 1 copy out of a space it no longer goes in.")).toBeInTheDocument();
    expect(screen.getByText("Placed by hand.")).toBeInTheDocument();
    expect((screen.getByRole("combobox", { name: "Where the memory of -Users-me-code-clubology goes" }) as HTMLSelectElement).value).toBe("skip");
  });

  it("says why nothing came in when the repo would not take it", async () => {
    await mount({ memoryRepos: { p1: fakeMemoryRepo() }, claudeBackfills: { p1: { last: { ...ran, error: "the memory repo has uncommitted changes" } } } });
    openMemory();
    expect(await screen.findByText("Nothing came in on the last check: the memory repo has uncommitted changes.")).toHaveAttribute("data-tone", "warning");
  });

  it("is a profile's row only: a space's own repo holds no Claude memory", async () => {
    const { api } = await mount({ memoryRepos: { p1: fakeMemoryRepo() } });
    openMemory();
    await waitFor(() => expect(api.calls).toContain("claudeBackfill:p1:false"));
    expect(await screen.findByText("Not checked yet.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.startsWith("importClaudeMemory"))).toBe(false);
  });
});

/**
 * Plan 27 Phase 2 — the General tab: a profile is edited and deleted here. What must die: a rename that
 * writes on every keystroke or writes a blank name, a delete one click away, a delete that does not say
 * what goes with it, and the last profile offered for deletion.
 */
describe("ProfilePage · General", () => {
  it("renames on commit — Enter or leaving the field — and puts a blank name back", async () => {
    const { api, store } = await mount();
    const field = screen.getByRole("textbox", { name: "Profile name" });
    fireEvent.change(field, { target: { value: "Day job" } });
    expect(api.calls.some((c) => c.startsWith("updateProfile"))).toBe(false);
    fireEvent.blur(field);
    await waitFor(() => expect(store.getState().profiles.find((p) => p.id === "p1")!.name).toBe("Day job"));
    expect(screen.getByRole("heading", { name: "Day job" })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);
    expect(field).toHaveValue("Day job");
    expect(api.calls.filter((c) => c.startsWith("updateProfile"))).toHaveLength(1);
  });

  it("recolours from the swatches, and a typed colour only once it is a whole #rrggbb", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Colour #3ddc97" }));
    await waitFor(() => expect(api.data.profiles.find((p) => p.id === "p1")!.color).toBe("#3ddc97"));
    const hex = screen.getByRole("textbox", { name: "Custom colour" });
    fireEvent.change(hex, { target: { value: "#12ab" } });
    expect(api.data.profiles.find((p) => p.id === "p1")!.color).toBe("#3ddc97");
    fireEvent.change(hex, { target: { value: "#12AB34" } });
    await waitFor(() => expect(api.data.profiles.find((p) => p.id === "p1")!.color).toBe("#12ab34"));
  });

  it("changes the icon through the same picker a space uses", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Change icon…" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Icon rocket" }));
    await waitFor(() => expect(api.data.profiles.find((p) => p.id === "p1")!.icon).toBe("rocket"));
  });

  it("delete says what goes with it, and only the profile's typed name arms it", async () => {
    const { api } = await mount({
      spaces: [space("s1", "p1", "Versed"), space("s3", "p1", "Side project"), space("s2", "p2", "Homework")],
      sessions: [session("a", "s1"), session("b", "s3"), session("c", "s2")],
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete profile…" }));
    // The counts are the server's, read when the confirm opens: Work's two spaces and their two
    // sessions — not School's.
    expect(await screen.findByText(/Deleting Work deletes its 2 spaces and 2 sessions\./)).toBeInTheDocument();
    expect(screen.getByText(/Folders on disk are kept/)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Delete Work" });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Type Work to confirm" }), { target: { value: "work" } });
    expect(go).toBeDisabled();
    expect(api.calls.some((c) => c.startsWith("deleteProfile"))).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Type Work to confirm" }), { target: { value: "Work" } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(api.calls).toContain("deleteProfile:p1"));
  });

  it("Cancel puts the confirm away, and opening it again asks for the name again", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete profile…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Type Work to confirm" }), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete profile…" }));
    expect(screen.getByRole("textbox", { name: "Type Work to confirm" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Delete Work" })).toBeDisabled();
  });

  it("the last profile cannot be deleted, and the page says why rather than hiding the button", async () => {
    await mount({ profiles: [profile("p1", "Work")], spaces: [space("s1", "p1", "Versed")] });
    expect(screen.getByRole("button", { name: "Delete profile…" })).toBeDisabled();
    expect(screen.getByText("This is the only profile, so it can't be deleted. Make another profile first.")).toBeInTheDocument();
  });
});

describe("ProfilePage · gone states", () => {
  it("says so when the space (and with it the profile vantage) no longer exists", async () => {
    await mount({}, "s-gone");
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});

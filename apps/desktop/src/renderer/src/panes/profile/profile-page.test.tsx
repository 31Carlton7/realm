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
    const { api } = await mount({ memoryRepoLogs: { p1: [{ sha: "a1b2c3d4", subject: "Create memory repo", at: Date.now() - 60_000 }] } });
    openMemory();
    expect(await screen.findByText("No memory repo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach existing…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    // THE MUTANT: create for the vantage space's id, or for another profile — the repo lands on the wrong owner.
    await waitFor(() => expect(api.calls).toContain("createMemoryRepo:p1"));
    expect(await screen.findByText("/realm-home/memory/repos/profile-p1")).toBeInTheDocument();
    expect(screen.getByText(/^Last saved .*: Create memory repo$/)).toBeInTheDocument();
    expect(screen.getByText("Nowhere. It stays on this Mac.")).toBeInTheDocument();
    expect(screen.getByText("Recent memories")).toBeInTheDocument();
  });

  it("attaches the picked folder, and says the server's refusal when it is not a memory repo", async () => {
    const refusal = "/tmp/picked-repo is not a memory repo: it has no MEMORY.md at its top";
    const { api, store } = await mount({ memoryRepoAttachError: refusal });
    openMemory();
    fireEvent.click(await screen.findByRole("button", { name: "Attach existing…" }));
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toContain(refusal));
    expect(api.calls).toContain("attachMemoryRepo:p1:/tmp/picked-repo");
    expect(screen.getByText("No memory repo")).toBeInTheDocument();
    api.data.memoryRepoAttachError = "";
    fireEvent.click(screen.getByRole("button", { name: "Attach existing…" }));
    expect(await screen.findByText("/tmp/picked-repo")).toBeInTheDocument();
  });

  it("says in words why agents cannot save, toned by how bad it is", async () => {
    const dirty = fakeMemoryRepo({ clean: false, uncommitted: ["draft.md"], reason: "1 uncommitted change — agents save again once the repo is clean" });
    const { store } = await mount({ memoryRepos: { p1: dirty } });
    openMemory();
    const line = await screen.findByText("1 uncommitted change — agents save again once the repo is clean.");
    // THE MUTANT: the status line ignores `clean` — it reads "Last saved…" while every save is refused.
    expect(line).toHaveAttribute("data-tone", "warning");
    act(() => store.setState({ profileMemoryRepo: { p1: fakeMemoryRepo({ valid: false, reason: "the folder is gone" }) } }));
    expect(screen.getByText("Not a memory repo: the folder is gone.")).toHaveAttribute("data-tone", "danger");
  });

  it("detaches this profile's repo and leaves the folder to the user", async () => {
    const { api } = await mount({ memoryRepos: { p1: fakeMemoryRepo() } });
    openMemory();
    const detach = await screen.findByRole("button", { name: "Detach" });
    expect(detach).toHaveAttribute("title", expect.stringContaining("The folder and its history stay where they are"));
    fireEvent.click(detach);
    await waitFor(() => expect(api.calls).toContain("detachMemoryRepo:p1"));
    expect(await screen.findByText("No memory repo")).toBeInTheDocument();
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

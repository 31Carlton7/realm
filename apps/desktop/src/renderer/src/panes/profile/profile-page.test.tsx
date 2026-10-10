import { describe, expect, it } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type AgentSignIn } from "@realm/contracts";
import { ProfilePage } from "./ProfilePage";
import { StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { claudeFolder, claudeRow, fakeApi, item, mcpServer, profile, session, skillRow, space, type FakeApi, type FakeData } from "../../state/store.test-fakes";

/** The page pane as PaneHost mounts it: a destination item whose refId is the kind's sentinel
 *  (Plan 14 W2) — the PROFILE is derived live from the item's space, never stored. */
const pageItem = (spaceId: string) =>
  item(`pg-profile-${spaceId}`, spaceId, { kind: "profile-page", title: "Profile", refId: PAGE_REF_IDS["profile-page"] });

/* Defaults (fakeApi): profiles p1 "Work" / p2 "School"; spaces s1 "Versed" (p1) / s2 "Homework" (p2). */
/** `before` runs once the window has booted and before the page is drawn, for a test that has to
 *  hold a reply back, or take something out of the store, ahead of the page's first ask. */
async function mount(overrides: FakeData = {}, spaceId = "s1", before: (api: FakeApi, store: ReturnType<typeof createAppStore>) => void = () => {}) {
  const api = fakeApi(overrides); const store = createAppStore(api); await store.getState().boot();
  before(api, store);
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

/** The fake's home folder (`systemInfo.userHome`), which is what `~` stands for on the page. */
const HOME = "/Users/carlton";
const WORK = `${HOME}/.claude-work`;
const CLIENT = `${HOME}/.claude-client`;
const SCHOOL = `${HOME}/.claude-school`;
/** The folder the fake answers as in force for a profile that names none. It is outside the fake's
 *  home, so the page shows it whole. */
const DEFAULT_FOLDER = "/home/.claude";

/** Work (p1) naming `~/.claude-work`, and signed in there on a team plan. */
const work = (over: FakeData = {}): FakeData => ({
  claudeDirs: { p1: claudeFolder(WORK) },
  profileClaude: { p1: claudeRow("work@example.com", WORK, { account: { email: "work@example.com", organization: "Acme", plan: "team" } }) },
  ...over,
});
/** Work and School each naming a folder of its own, each signed in as its own account. */
const twoAccounts = (): FakeData => ({
  claudeDirs: { p1: claudeFolder(WORK), p2: claudeFolder(SCHOOL) },
  profileClaude: { p1: claudeRow("work@example.com", WORK), p2: claudeRow("school@example.com", SCHOOL) },
});
/** Claude's row for a folder nobody has signed in to. It carries the CLI's own words, as the
 *  server's does, which the page must not print in place of its own sentence. */
const signedOut: AgentProbe = { kind: "claude", available: true, version: "2.1.296", loggedIn: false, reason: "Not logged in · Please run /login", home: WORK };
/** Claude's row as the server answers it for a named folder that is not on disk: signed out and
 *  flagged, in the server's own sentence, since Claude Code is asked nothing about such a folder. */
const goneRow: AgentProbe = { ...signedOut, reason: "The Claude config folder ~/.claude-work is missing.", homeMissing: true };

const folderField = () => screen.getByRole("textbox", { name: "Claude config folder" });
/** What the line under the field says. */
const signInLine = () => screen.getByRole("status").textContent;
/** The folder writes the page has sent, in the order it sent them. */
const writes = (api: FakeApi) => api.calls.filter((c) => c.startsWith("setClaudeDir:"));
/** The asks made for a profile's own Claude row, in the order they were made. */
const asks = (api: FakeApi) => api.calls.filter((c) => c.includes(":profile:"));
/** Long enough for an answer the fake holds for no time at all to have landed. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
/** The page's space moved to School (p2) under the open page, which moves the page with it. */
const moveToSchool = (store: ReturnType<typeof createAppStore>) =>
  act(() => store.setState({ spaces: store.getState().spaces.map((sp) => (sp.id === "s1" ? { ...sp, profileId: "p2" } : sp)) }));

describe("ProfilePage · General · the Claude config folder", () => {
  it("shows the default folder in the field where the profile names none, written with ~ for home", async () => {
    await mount({ claudeDirs: { p1: claudeFolder(null, { inForce: `${HOME}/.claude` }) } });
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude"));
    expect(folderField()).toBeEnabled();
  });

  it("offers no Use the default while the profile names no folder", async () => {
    await mount();
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    expect(screen.queryByRole("button", { name: "Use the default" })).toBeNull();
  });

  it("gives a named folder back with Use the default, and then offers it no longer", async () => {
    const { api } = await mount(work());
    fireEvent.click(await screen.findByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    expect(writes(api)).toEqual(["setClaudeDir:p1=default"]);
    expect(screen.queryByRole("button", { name: "Use the default" })).toBeNull();
  });

  it("names the folder typed on Enter, trimmed, and shows it as the server stored it", async () => {
    const { api } = await mount();
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    folderField().focus();
    fireEvent.change(folderField(), { target: { value: `  ${WORK} ` } });
    expect(writes(api)).toEqual([]);
    fireEvent.keyDown(folderField(), { key: "Enter" });
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    expect(writes(api)).toEqual([`setClaudeDir:p1=${WORK}`]);
  });

  it("sends nothing when the field is left reading what it showed", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.blur(folderField());
    fireEvent.change(folderField(), { target: { value: " ~/.claude-work " } });
    fireEvent.blur(folderField());
    expect(folderField()).toHaveValue("~/.claude-work");
    expect(writes(api)).toEqual([]);
  });

  it("sends nothing when the field is emptied while the profile names no folder, and shows the default folder again", async () => {
    const { api } = await mount();
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    fireEvent.change(folderField(), { target: { value: "  " } });
    fireEvent.blur(folderField());
    expect(folderField()).toHaveValue(DEFAULT_FOLDER);
    await settle();
    expect(writes(api)).toEqual([]);
  });

  it("keeps a half-typed folder in the field, and sends nothing, when the window loses the keyboard with the field still in it", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    folderField().focus();
    fireEvent.change(folderField(), { target: { value: CLIENT } });
    fireEvent.blur(folderField());
    await settle();
    expect(writes(api)).toEqual([]);
    expect(folderField()).toHaveValue(CLIENT);
  });

  it("sends the typed folder once the keyboard moves from the field to another control", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    folderField().focus();
    fireEvent.change(folderField(), { target: { value: CLIENT } });
    act(() => screen.getByRole("textbox", { name: "Profile name" }).focus());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-client"));
    expect(writes(api)).toEqual([`setClaudeDir:p1=${CLIENT}`]);
  });

  it("gives the folder back when the field is emptied, and never sends the empty text as a path", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.change(folderField(), { target: { value: "  " } });
    fireEvent.blur(folderField());
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    expect(writes(api)).toEqual(["setClaudeDir:p1=default"]);
  });

  it("puts the stored folder back in the field when the server refuses the one typed, and says why in a toast", async () => {
    const { api, store } = await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.change(folderField(), { target: { value: "claude-client" } });
    fireEvent.blur(folderField());
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toContain("A Claude config folder needs a full path, such as ~/.claude-work."));
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    expect(writes(api)).toEqual(["setClaudeDir:p1=claude-client"]);
  });

  it("puts the shown folder back on Escape, so leaving the field then sends nothing", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.change(folderField(), { target: { value: CLIENT } });
    fireEvent.keyDown(folderField(), { key: "Escape" });
    expect(folderField()).toHaveValue("~/.claude-work");
    fireEvent.blur(folderField());
    expect(writes(api)).toEqual([]);
  });

  it("keeps Escape from the page while there is a typed folder to put back, and hands it over once there is none", async () => {
    await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    const heard: string[] = [];
    const page = (e: KeyboardEvent) => { heard.push(e.key); };
    window.addEventListener("keydown", page);
    try {
      fireEvent.change(folderField(), { target: { value: CLIENT } });
      fireEvent.keyDown(folderField(), { key: "Escape" });
      expect(heard).toEqual([]);
      fireEvent.keyDown(folderField(), { key: "Escape" });
      expect(heard).toEqual(["Escape"]);
    } finally { window.removeEventListener("keydown", page); }
  });

  it("asks for a folder dialog that lists hidden folders, offers no New Folder, hands an alias back as it is named, and opens on the folder that holds the one in force", async () => {
    const { api } = await mount(work());
    const asked: unknown[] = [];
    api.pickFolder = async (o) => { asked.push(o); return null; };
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(asked).toEqual([{ hidden: true, create: false, aliases: false, from: HOME }]));
  });

  it("asks for the same dialog on the default folder, opened on the folder that holds it", async () => {
    const { api } = await mount();
    const asked: unknown[] = [];
    api.pickFolder = async (o) => { asked.push(o); return null; };
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(asked).toEqual([{ hidden: true, create: false, aliases: false, from: "/home" }]));
  });

  it("sends nothing of a half-typed folder when the folder dialog opens over the field", async () => {
    const { api } = await mount(work());
    let asked = 0;
    api.pickFolder = () => { asked += 1; return new Promise<string | null>(() => {}); };
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    folderField().focus();
    fireEvent.change(folderField(), { target: { value: "/Users/carlton/.cl" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    fireEvent.blur(folderField());
    await settle();
    expect(asked).toBe(1);
    expect(writes(api)).toEqual([]);
    expect(folderField()).toHaveValue("/Users/carlton/.cl");
  });

  it("names the folder picked in the dialog", async () => {
    const { api } = await mount();
    api.pickFolder = async () => WORK;
    await waitFor(() => expect(folderField()).toHaveValue(DEFAULT_FOLDER));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    expect(writes(api)).toEqual([`setClaudeDir:p1=${WORK}`]);
  });

  it("leaves a named folder as it is when the dialog is cancelled", async () => {
    const { api } = await mount(work());
    let asked = 0;
    api.pickFolder = async () => { asked += 1; return null; };
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(asked).toBe(1));
    await settle();
    expect(writes(api)).toEqual([]);
    expect(folderField()).toHaveValue("~/.claude-work");
  });

  it("opens no second dialog for a second press on Choose… while the first is still up", async () => {
    const { api } = await mount(work());
    let asked = 0;
    api.pickFolder = () => { asked += 1; return new Promise<string | null>(() => {}); };
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(asked).toBe(1);
  });

  it("leaves the keyboard in the field through a press on either button beside it, so a half-typed folder is not sent on the way", async () => {
    await mount(work());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Choose…" }))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Use the default" }))).toBe(false);
  });

  it("reads the profile's folder itself where the window holds none, and shows no path until it has", async () => {
    await mount(work(), "s1", (api, store) => { store.setState({ claudeDirs: {} }); api.delays["claudeDir:p1"] = 200; });
    expect(folderField()).toBeDisabled();
    expect(folderField()).toHaveValue("");
    expect(folderField()).toHaveAttribute("placeholder", "Checking…");
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    expect(folderField()).toBeEnabled();
  });

  it("keeps its one line of help under a folder that is missing", async () => {
    await mount(work({ claudeDirs: { p1: claudeFolder(WORK, { missing: true }) } }));
    expect(await screen.findByText("New Claude sessions in Work's spaces use this folder's sign-in, memory, and commands. A conversation keeps the sign-in it began with.")).toBeInTheDocument();
  });
});

describe("ProfilePage · General · whether the folder is signed in", () => {
  it("says who the folder is signed in as, with the plan and the organisation in the bracket", async () => {
    await mount(work());
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Team, Acme)."));
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("leaves the organisation out of the bracket where it only restates the email", async () => {
    await mount(work({ profileClaude: { p1: claudeRow("owner@example.com", WORK, { account: { email: "owner@example.com", organization: "owner@example.com's Organization", plan: "max" } }) } }));
    await waitFor(() => expect(signInLine()).toBe("Signed in as owner@example.com (Claude Max)."));
  });

  it("says only that the folder is signed in where its sign-in names no account", async () => {
    await mount(work({ profileClaude: { p1: { kind: "claude", available: true, version: "2.1.296", loggedIn: true, reason: null, home: WORK } } }));
    await waitFor(() => expect(signInLine()).toBe("Signed in."));
  });

  it("offers Sign in where the folder is not signed in, on a line that reads Not signed in.", async () => {
    await mount(work({ profileClaude: { p1: signedOut } }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(signInLine()).toBe("Not signed in.");
  });

  it("says a named folder is missing and offers no Sign in for it, though its row reads signed out", async () => {
    await mount(work({ claudeDirs: { p1: claudeFolder(WORK, { missing: true }) }, profileClaude: { p1: signedOut } }));
    const missing = "This folder is missing. Claude sessions in Work's spaces can't start until you choose a folder or use the default.";
    await waitFor(() => expect(signInLine()).toBe(missing));
    await settle();
    expect(signInLine()).toBe(missing);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("says a named folder is missing and offers no Sign in for it where only its row says so, the folder's own answer being from before it went", async () => {
    await mount(work({ profileClaude: { p1: goneRow } }));
    await waitFor(() => expect(signInLine()).toBe("This folder is missing. Claude sessions in Work's spaces can't start until you choose a folder or use the default."));
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("asks for the row afresh when the window comes back to the front while only the row says the folder is missing, and finds the folder back and signed in", async () => {
    const { api } = await mount(work({ profileClaude: { p1: goneRow } }));
    await waitFor(() => expect(signInLine()).toMatch(/^This folder is missing\./));
    api.data.profileClaude.p1 = claudeRow("work@example.com", WORK);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1", "probeAgent:claude:forced:profile:p1"]);
  });

  it("asks for no row when the window comes back to the front while the folder's own answer says it is missing, which no probe is run for", async () => {
    const { api } = await mount(work({ claudeDirs: { p1: claudeFolder(WORK, { missing: true }) }, profileClaude: { p1: goneRow } }));
    await waitFor(() => expect(signInLine()).toMatch(/^This folder is missing\./));
    await settle();
    fireEvent(window, new Event("focus"));
    await settle();
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1"]);
  });

  it("names the variable that outranks the folder's sign-in, in mono, and offers no Sign in", async () => {
    await mount(work({ claudeDirs: { p1: claudeFolder(WORK, { override: "ANTHROPIC_API_KEY" }) }, profileClaude: { p1: signedOut } }));
    await waitFor(() => expect(signInLine()).toBe("Realm's environment sets ANTHROPIC_API_KEY, which Claude uses instead of this folder's sign-in."));
    expect(within(screen.getByRole("status")).getByText("ANTHROPIC_API_KEY").tagName).toBe("CODE");
    await settle();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("says Claude Code's own reason, and offers no Sign in, where Claude Code is not installed", async () => {
    await mount(work({ profileClaude: { p1: { kind: "claude", available: false, version: null, loggedIn: false, reason: "spawn claude ENOENT", home: WORK } } }));
    await waitFor(() => expect(signInLine()).toBe("spawn claude ENOENT"));
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("says Realm can't tell where the folder's row cannot say and gives no reason", async () => {
    await mount(work({ profileClaude: { p1: { kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null, home: WORK } } }));
    await waitFor(() => expect(signInLine()).toBe("Realm can't tell whether this folder is signed in."));
  });

  it("asks afresh when the window comes back to the front while it can't tell, and says who the folder is signed in as once the row can", async () => {
    const { api } = await mount(work({ profileClaude: { p1: { kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null, home: WORK } } }));
    await waitFor(() => expect(signInLine()).toBe("Realm can't tell whether this folder is signed in."));
    api.data.profileClaude.p1 = claudeRow("work@example.com", WORK);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1", "probeAgent:claude:forced:profile:p1"]);
  });

  it("reads Checking… until the folder's own row has answered", async () => {
    await mount(work(), "s1", (api) => { api.delays.probeAgent = 200; });
    expect(signInLine()).toBe("Checking…");
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Team, Acme)."));
  });

  it("asks once for the page's own profile as the tab opens, from what the server last learned", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Team, Acme)."));
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1"]);
  });

  it("says Checking… again, and asks again, once the profile is named another folder", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Team, Acme)."));
    api.data.profileClaude.p1 = claudeRow("client@example.com", CLIENT);
    api.delays.probeAgent = 200;
    fireEvent.change(folderField(), { target: { value: CLIENT } });
    fireEvent.blur(folderField());
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-client"));
    expect(signInLine()).toBe("Checking…");
    await waitFor(() => expect(signInLine()).toBe("Signed in as client@example.com (Claude Max)."));
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1", "probeAgent:claude:plain:profile:p1"]);
  });

  it("asks afresh each time the window comes back to the front while the folder is not signed in, and no more once it is", async () => {
    const { api } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    api.data.profileClaude.p1 = claudeRow("work@example.com", WORK);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
    fireEvent(window, new Event("focus"));
    await settle();
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1", "probeAgent:claude:forced:profile:p1"]);
  });

  it("keeps the line and its button as they were when the fresh ask made as the window comes back to the front fails, since a lost call says nothing of the sign-in", async () => {
    const { api } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    const answering = api.probeAgent;
    let lost = 0;
    api.probeAgent = (kind, o) => {
      if (!o?.profileId) return answering(kind, o);
      lost += 1;
      return Promise.reject(new Error("the server went away"));
    };
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(lost).toBe(1));
    await settle();
    expect(signInLine()).toBe("Not signed in.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("says Checking…, never the first profile's account, once the page moves to a second profile", async () => {
    const { api, store } = await mount(twoAccounts());
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
    api.delays.probeAgent = 200;
    moveToSchool(store);
    expect(screen.getByRole("heading", { name: "School" })).toBeInTheDocument();
    expect(folderField()).toHaveValue("~/.claude-school");
    expect(signInLine()).toBe("Checking…");
    await waitFor(() => expect(signInLine()).toBe("Signed in as school@example.com (Claude Max)."));
  });

  it("lets go of an answer that lands for the profile the page has left", async () => {
    const { api, store } = await mount(twoAccounts(), "s1", (held) => { held.delays.probeAgent = 150; });
    api.delays.probeAgent = 0;
    moveToSchool(store);
    await waitFor(() => expect(signInLine()).toBe("Signed in as school@example.com (Claude Max)."));
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(signInLine()).toBe("Signed in as school@example.com (Claude Max).");
  });

  it("keeps the second folder's account on the line when the answer for the first folder lands after it", async () => {
    let landFirst: (row: AgentProbe | null) => void = () => {};
    const { api } = await mount(work(), "s1", (held) => {
      const answering = held.probeAgent;
      let asked = 0;
      held.probeAgent = (kind, o) => (o?.profileId && asked++ === 0 ? new Promise<AgentProbe | null>((land) => { landFirst = land; }) : answering(kind, o));
    });
    await waitFor(() => expect(folderField()).toHaveValue("~/.claude-work"));
    expect(signInLine()).toBe("Checking…");
    api.data.profileClaude.p1 = claudeRow("client@example.com", CLIENT);
    fireEvent.change(folderField(), { target: { value: CLIENT } });
    fireEvent.blur(folderField());
    await waitFor(() => expect(signInLine()).toBe("Signed in as client@example.com (Claude Max)."));
    await act(async () => { landFirst(claudeRow("work@example.com", WORK)); });
    await settle();
    expect(signInLine()).toBe("Signed in as client@example.com (Claude Max).");
  });

  it("reads the folders again when the window comes back to the front while the folder is missing, and finds it put back", async () => {
    const { api } = await mount(work({ claudeDirs: { p1: claudeFolder(WORK, { missing: true }) } }));
    await waitFor(() => expect(signInLine()).toMatch(/^This folder is missing\./));
    api.data.claudeDirs.p1 = claudeFolder(WORK);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Team, Acme)."));
  });

  it("reads Checking…, and offers no Sign in, once a missing folder is found put back, until a row asked about the folder as it is now has landed", async () => {
    const { api } = await mount(work({ claudeDirs: { p1: claudeFolder(WORK, { missing: true }) }, profileClaude: { p1: goneRow } }));
    await waitFor(() => expect(signInLine()).toMatch(/^This folder is missing\./));
    await settle();
    api.data.claudeDirs.p1 = claudeFolder(WORK);
    api.data.profileClaude.p1 = claudeRow("work@example.com", WORK);
    api.delays.probeAgent = 200;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(signInLine()).toBe("Checking…"));
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
  });

  it("reads the folders again when the window comes back to the front while the folder is not signed in, and finds it gone", async () => {
    const { api } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    api.data.claudeDirs.p1 = claudeFolder(WORK, { missing: true });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(signInLine()).toMatch(/^This folder is missing\./));
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("reads no folder again on the window coming back to the front once the folder is signed in", async () => {
    const { api } = await mount(work());
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Team, Acme)."));
    const reads = api.calls.filter((c) => c.startsWith("claudeDir:")).length;
    fireEvent(window, new Event("focus"));
    await settle();
    expect(api.calls.filter((c) => c.startsWith("claudeDir:"))).toHaveLength(reads);
  });
});

/** School (p2) in a space of its own (`s9`), naming a folder nobody has signed in to, in a window
 *  that shows Work (p1). */
const schoolSignedOut = (): FakeData => ({
  spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Thesis")],
  claudeDirs: { p2: claudeFolder(SCHOOL) },
  profileClaude: { p2: { ...signedOut, home: SCHOOL } },
});
/** School in that same space and window, naming no folder, with nobody signed in to the default
 *  one. A row asked for School is told apart from one the window asks for Work, the profile it
 *  shows, though both are about the default folder. */
const schoolOnDefault = (): FakeData => ({
  spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Thesis")],
  profileClaude: { p2: { ...signedOut, home: null } },
});
/** A space-less Claude sign-in as the server reports it. `home` is the folder it lands in, and with
 *  none it lands in the default folder. */
const claudeSignIn = (state: AgentSignIn["state"], home?: string, over: Partial<AgentSignIn> = {}): AgentSignIn =>
  ({ id: "si-claude", kind: "claude", state, url: null, detail: null, ...(home === undefined ? {} : { home }), ...over });
/** The asks made for School's own Claude row, in the order they were made. A sign-in started for
 *  School names the profile too, and is not one of them. */
const schoolRowAsks = (api: FakeApi) => api.calls.filter((c) => c.startsWith("probeAgent:claude:") && c.endsWith(":profile:p2"));
/** What a sign-in's steps say once its page is up, which is how a test knows they are drawn. */
const IN_BROWSER = "Finish signing in in your browser.";
/** The sentence the first run's card says of a sign-in that did not finish. */
const DID_NOT_FINISH = "The sign-in didn't finish. Try again.";

describe("ProfilePage · General · signing the folder in", () => {
  it("starts the sign-in for the page's own profile, which is not the one the window shows, and in no space", async () => {
    const { api, store } = await mount(schoolSignedOut(), "s9");
    expect(store.getState().activeProfileId).toBe("p1");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("agentSignInStart:claude:profile:"))).toEqual(["agentSignInStart:claude:profile:p2"]));
    expect(api.calls.some((c) => c.startsWith("startSignIn:"))).toBe(false);
  });

  it("draws the sign-in's steps in place of the line once the sign-in it started is running", async () => {
    await mount(work({ profileClaude: { p1: signedOut } }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(IN_BROWSER)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the page again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("draws the steps of a sign-in for the default folder on the page of a profile that names none", async () => {
    const { store } = await mount({ profileClaude: { p1: { ...signedOut, home: null } } });
    await screen.findByRole("button", { name: "Sign in" });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("browser")));
    expect(screen.getByText(IN_BROWSER)).toBeInTheDocument();
  });

  it("draws no steps for a sign-in that lands in another folder, named or the default one", async () => {
    const { store } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    for (const elsewhere of [claudeSignIn("browser", SCHOOL), claudeSignIn("browser")]) {
      act(() => store.getState().applyAgentSignIn(elsewhere));
      expect(screen.queryByText(IN_BROWSER)).toBeNull();
      expect(signInLine()).toBe("Not signed in.");
      expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    }
  });

  it("says on Sign in that a press stops the Claude sign-in running for another folder, and says nothing there before one runs or once it has ended", async () => {
    const { store } = await mount(work({ profileClaude: { p1: signedOut } }));
    expect(await screen.findByRole("button", { name: "Sign in" })).not.toHaveAttribute("title");
    act(() => store.getState().applyAgentSignIn(claudeSignIn("browser", SCHOOL)));
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("title", "Starting this sign-in stops the Claude sign-in that is running for another folder.");
    act(() => store.getState().applyAgentSignIn(claudeSignIn("cancelled", SCHOOL)));
    expect(screen.getByRole("button", { name: "Sign in" })).not.toHaveAttribute("title");
  });

  it("sends a code typed into the field for Claude's sign-in page to the sign-in", async () => {
    const { api, store } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("code", WORK)));
    const code = screen.getByRole("textbox", { name: "Code from Claude's sign-in page" });
    fireEvent.change(code, { target: { value: "ABCD-1234" } });
    fireEvent.keyDown(code, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("agentSignInCode:si-claude:9"));
  });

  it("leaves a code typed for one sign-in out of the field of the sign-in that takes its place, and keeps it through a new report of the same one", async () => {
    const { store } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    const code = () => screen.getByRole("textbox", { name: "Code from Claude's sign-in page" });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("code", WORK)));
    fireEvent.change(code(), { target: { value: "ABCD-1234" } });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("code", WORK, { url: "https://example.com/oauth/authorize" })));
    expect(code()).toHaveValue("ABCD-1234");
    act(() => store.getState().applyAgentSignIn(claudeSignIn("code", WORK, { id: "si-next" })));
    expect(code()).toHaveValue("");
  });

  it("stops the sign-in from Cancel", async () => {
    const { api, store } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("browser", WORK)));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.calls).toContain("agentSignInCancel:si-claude"));
  });

  it("asks for a named folder's row again when the sign-in it watched is done, from what the server has just read, and says who the folder is then signed in as", async () => {
    const { api, store } = await mount(schoolSignedOut(), "s9");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(IN_BROWSER);
    api.data.profileClaude.p2 = claudeRow("school@example.com", SCHOOL);
    act(() => store.getState().applyAgentSignIn(claudeSignIn("done", SCHOOL)));
    await waitFor(() => expect(signInLine()).toBe("Signed in as school@example.com (Claude Max)."));
    expect(schoolRowAsks(api)).toEqual(["probeAgent:claude:plain:profile:p2", "probeAgent:claude:plain:profile:p2"]);
  });

  it("asks afresh for the row of a profile on the default folder when the sign-in it watched is done, since the server only amended its list of every agent", async () => {
    const { api, store } = await mount(schoolOnDefault(), "s9");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(IN_BROWSER);
    api.data.profileClaude.p2 = claudeRow("school@example.com");
    act(() => store.getState().applyAgentSignIn(claudeSignIn("done")));
    await waitFor(() => expect(signInLine()).toBe("Signed in as school@example.com (Claude Max)."));
    expect(schoolRowAsks(api)).toEqual(["probeAgent:claude:plain:profile:p2", "probeAgent:claude:forced:profile:p2"]);
  });

  it("reads Checking…, and offers no Sign in, from the moment the sign-in it watched is done until the folder's row has landed, and then says who the folder is signed in as", async () => {
    const { api, store } = await mount(work({ profileClaude: { p1: signedOut } }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(IN_BROWSER);
    api.data.profileClaude.p1 = claudeRow("work@example.com", WORK);
    api.delays.probeAgent = 200;
    act(() => store.getState().applyAgentSignIn(claudeSignIn("done", WORK)));
    expect(signInLine()).toBe("Checking…");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
  });

  it("says Realm can't tell, and does not read Checking… for good, where the fresh ask made after a finished sign-in fails", async () => {
    const { api, store } = await mount(schoolOnDefault(), "s9");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(IN_BROWSER);
    const answering = api.probeAgent;
    api.probeAgent = (kind, o) => (o?.profileId === "p2" ? Promise.reject(new Error("the server went away")) : answering(kind, o));
    act(() => store.getState().applyAgentSignIn(claudeSignIn("done")));
    await waitFor(() => expect(signInLine()).toBe("Realm can't tell whether this folder is signed in."));
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("asks for nothing more for a sign-in that was done before the page was drawn", async () => {
    const { api } = await mount(schoolSignedOut(), "s9", (_held, store) => { store.getState().applyAgentSignIn(claudeSignIn("done", SCHOOL)); });
    await screen.findByRole("button", { name: "Sign in" });
    await settle();
    expect(schoolRowAsks(api)).toEqual(["probeAgent:claude:plain:profile:p2"]);
  });

  it("puts the line and its button back when the sign-in did not finish, under the sentence the first run's card says of one", async () => {
    const { store } = await mount(work({ profileClaude: { p1: signedOut } }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(IN_BROWSER);
    act(() => store.getState().applyAgentSignIn(claudeSignIn("failed", WORK, { detail: "Error: network" })));
    expect(screen.queryByText(IN_BROWSER)).toBeNull();
    expect(signInLine()).toBe("Not signed in.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    const said = screen.getByText(DID_NOT_FINISH);
    expect(said).toHaveAttribute("title", "Error: network");
    expect(said.compareDocumentPosition(screen.getByRole("status")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says nothing of a sign-in for another folder that did not finish", async () => {
    const { store } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("failed", SCHOOL)));
    expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
  });

  it("puts the line and its button back, with nothing said, when the sign-in is cancelled", async () => {
    const { store } = await mount(work({ profileClaude: { p1: signedOut } }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(IN_BROWSER);
    act(() => store.getState().applyAgentSignIn(claudeSignIn("cancelled", WORK)));
    expect(signInLine()).toBe("Not signed in.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
  });

  it("asks afresh for the row when the sign-in it watched is cancelled, and says who the folder is signed in as where the login had finished all the same", async () => {
    const { api, store } = await mount(work({ profileClaude: { p1: signedOut } }));
    await screen.findByRole("button", { name: "Sign in" });
    act(() => store.getState().applyAgentSignIn(claudeSignIn("browser", WORK)));
    await screen.findByText(IN_BROWSER);
    api.data.profileClaude.p1 = claudeRow("work@example.com", WORK);
    act(() => store.getState().applyAgentSignIn(claudeSignIn("cancelled", WORK)));
    expect(signInLine()).toBe("Not signed in.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    await waitFor(() => expect(signInLine()).toBe("Signed in as work@example.com (Claude Max)."));
    expect(asks(api)).toEqual(["probeAgent:claude:plain:profile:p1", "probeAgent:claude:forced:profile:p1"]);
  });
});

/** A file of main, the preload or the renderer as text. Importing main or the preload would start
 *  Electron, so what each does with the folder dialog can only be read. */
const text = (found: Record<string, unknown>): string => String(Object.values(found)[0]);
const MAIN = text(import.meta.glob("../../../../main/index.ts", { query: "?raw", import: "default", eager: true }));
const PRELOAD = text(import.meta.glob("../../../../preload/index.ts", { query: "?raw", import: "default", eager: true }));
const LIVE_API = text(import.meta.glob("../../state/live-api.ts", { query: "?raw", import: "default", eager: true }));
/** Main's `pick-folder` handler, from where it is registered to the end of its body, on one line. */
const PICK_FOLDER = (MAIN.slice(MAIN.indexOf('ipcMain.handle("pick-folder"')).split("\n});")[0] ?? "").replace(/\s+/g, " ");

describe("the folder dialog, from a page to main", () => {
  it("is handed what the page asked for at every step on the way", () => {
    expect(LIVE_API).toContain("pickFolder: (o) => window.realm.pickFolder(o),");
    expect(PRELOAD).toMatch(/pickFolder: \(o\?: \{[^}]*\}\): Promise<string \| null> => ipcRenderer\.invoke\("pick-folder", o\),/);
    expect(PICK_FOLDER).toMatch(/^ipcMain\.handle\("pick-folder", async \(_e, o\?: \{/);
  });

  it("lists hidden folders only for a caller that asked for them", () => {
    expect(PICK_FOLDER).toContain('...(o?.hidden === true ? ["showHiddenFiles" as const] : [])');
  });

  it("offers New Folder to every caller but the one that said not to", () => {
    expect(PICK_FOLDER).toContain('properties: ["openDirectory", ...(o?.create === false ? [] : ["createDirectory" as const]),');
  });

  it("answers the folder an alias points at for every caller but the one that said not to", () => {
    expect(PICK_FOLDER).toContain('...(o?.aliases === false ? ["noResolveAliases" as const] : [])');
  });

  it("gives a caller that asks only for hidden folders only that, with an alias still answered by the folder it points at", () => {
    expect(PICK_FOLDER.match(/noResolveAliases/g)).toHaveLength(1);
    expect(PICK_FOLDER.match(/o\?\.aliases/g)).toHaveLength(1);
  });

  it("opens at the folder a caller named, and only then says where to open", () => {
    expect(PICK_FOLDER).toContain("const from = o?.from;");
    expect(PICK_FOLDER).toContain('...(typeof from === "string" && from !== "" ? { defaultPath: from } : {})');
  });
});

describe("ProfilePage · gone states", () => {
  it("says so when the space (and with it the profile vantage) no longer exists", async () => {
    await mount({}, "s-gone");
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});

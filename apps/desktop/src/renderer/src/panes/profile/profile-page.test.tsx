import { describe, expect, it } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { ProfilePage } from "./ProfilePage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, mcpServer, skillRow, space, type FakeData } from "../../state/store.test-fakes";

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

  it("the chip strip is a BAND of the page, a sibling of the head and the body", async () => {
    // It takes the page's measure and gutter from the band rule in styles.css, which reaches it only
    // as a direct child of `.page`. Nested inside the head or the body it would take the gutter
    // twice and sit 24px inside the column every other band starts at.
    const { container } = await mount();
    expect(container.querySelector(".page > .profile-spaces")).toBe(screen.getByLabelText("Spaces of Work"));
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

  it("the rail moves between Skills, Connections and Memory", async () => {
    await mount({ profileMemoryDocs: { p1: "profile-wide context" } });
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
    const own = within(await screen.findByText("Work's skills").then((el) => el.closest(".field") as HTMLElement));
    expect(own.getByText("mine")).toBeInTheDocument();
    // The named W2 mutant: another profile's item surfacing (editable or at all) on this page.
    expect(screen.queryByText("foreign")).toBeNull();
    // A space's own row belongs to that space's page, not here.
    expect(screen.queryByText("space-only")).toBeNull();
    const everywhere = within(screen.getByText("Everywhere").closest(".field") as HTMLElement);
    expect(everywhere.getByText("legacy")).toBeInTheDocument();
    // Read-only: no move, no switch — just the note pointing at its space of use.
    expect(everywhere.queryByRole("button")).toBeNull();
    expect(everywhere.getByText(/manage it from a space page/)).toBeInTheDocument();
  });

  it("demote ('Keep in one space…') confirms, names the vantage space, and fires DEMOTE — never promote", async () => {
    const { api } = await mount({ skills: { s1: [...rows] } });
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
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(api.data.profileMemoryDocs.p1).toBe("new profile-wide rule"));
    expect(api.data.profileMemoryDocs.p2).toBe("other profile's doc");
  });
});

describe("ProfilePage · gone states", () => {
  it("says so when the space (and with it the profile vantage) no longer exists", async () => {
    await mount({}, "s-gone");
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { itemIdOfLeaf } from "@realm/contracts";
import { NewSpaceSheet } from "./NewSpaceSheet";
import { SpaceIcon } from "../SpaceIcon";
import { StoreContext, createAppStore, useApp } from "../../state/store";
import { fakeApi, iconAsset } from "../../state/store.test-fakes";

/** The sheet as the app hosts it: open while the store says so, gone the moment it closes — which is
 *  what lets a test see Create close it and Escape leave it up. */
function Host() {
  const open = useApp((s) => s.sheet?.kind === "new-space");
  return open ? <NewSpaceSheet /> : null;
}

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  store.getState().openSheet({ kind: "new-space" });
  const r = render(<StoreContext.Provider value={store}><Host /></StoreContext.Provider>);
  return { store, api, ...r };
}

const nameField = () => screen.getByRole("textbox", { name: "Space name" });
const create = () => screen.getByRole("button", { name: "Create" });
const tile = () => screen.getByRole("button", { name: "Change icon" });
/** A glyph by its strokes — the attribute order of two renders of one icon is not the icon. */
const drawn = (el: Element) => [...el.querySelectorAll("path")].map((p) => p.getAttribute("d"));

describe("NewSpaceSheet", () => {
  it("opens with the name holding the keyboard, and Enter there lands IN the new space: a new session, prompter focused — not the space's page", async () => {
    /* The fast path is a name and Return. THE mutants: the sheet's own first-control focus winning
       (the icon tile has the keyboard), or Create navigating where it used to — the new space's
       Overview, its General settings, with no session started. */
    const { store, api } = await mount();
    expect(document.activeElement).toBe(nameField());
    fireEvent.change(nameField(), { target: { value: "Versed 2" } });
    fireEvent.submit(nameField().closest("form")!);
    await waitFor(() => expect(store.getState().keyboardFor).not.toBeNull());
    const s = store.getState();
    const made = s.spaces.find((x) => x.name === "Versed 2")!;
    const session = Object.values(s.sessions).find((x) => x.spaceId === made.id)!;
    expect(session).toBeDefined();
    expect(s.pageOverlay).toBeNull();
    expect(s.items.find((i) => i.id === itemIdOfLeaf(s.layout!, s.focusedLeafId!))?.refId).toBe(session.id);
    expect(s.keyboardFor?.sessionId).toBe(session.id);
    expect(api.calls.filter((c) => c.startsWith("createSession:"))).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "New space" })).toBeNull();
  });

  it("previews the icon and the colour beside the name as they are picked, and makes the space wearing them", async () => {
    const { store } = await mount();
    const folderGlyph = drawn(tile());
    const before = tile().style.color;
    fireEvent.click(tile());
    fireEvent.click(await screen.findByRole("radio", { name: "Icon rocket" }));
    // The tile draws what the sidebar's SpaceIcon will draw for the space.
    const { container } = render(<StoreContext.Provider value={store}><SpaceIcon icon="rocket" size={20} /></StoreContext.Provider>);
    await waitFor(() => expect(drawn(tile())).toEqual(drawn(container)));
    expect(drawn(tile())).not.toEqual(folderGlyph);
    fireEvent.click(screen.getByRole("radio", { name: "Color #ff6b8b" }));
    expect(screen.getByRole("radio", { name: "Color #ff6b8b" })).toHaveAttribute("aria-checked", "true");
    expect(tile().style.color).not.toBe(before);
    expect(tile().style.color).not.toBe("");
    fireEvent.change(nameField(), { target: { value: "Rockets" } });
    fireEvent.click(create());
    await waitFor(() => expect(store.getState().spaces.some((x) => x.name === "Rockets")).toBe(true));
    expect(store.getState().spaces.find((x) => x.name === "Rockets")).toMatchObject({ icon: "rocket", color: "#ff6b8b" });
  });

  it("starts on the next colour along, and the arrows move it — one stop for Tab", async () => {
    // Two spaces exist, so the third colour of the palette; the group is a radio group, not ten stops.
    await mount();
    const radios = within(screen.getByRole("radiogroup", { name: "Color" })).getAllByRole("radio");
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.getAttribute("aria-label"))).toEqual(["Color #ffb454"]);
    expect(radios.filter((r) => r.tabIndex === 0)).toEqual(checked);
    checked[0]!.focus();
    fireEvent.keyDown(checked[0]!, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Color #ff6b8b" })).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Color #ff6b8b" }));
  });

  it("says where a space without a folder will work — the server's answer, following the name as it is typed", async () => {
    /* THE mutant is a line that guesses: a slug the renderer made up, or one that stops following
       the name. With a folder chosen there is nothing to say, and nothing is said. */
    const { api } = await mount();
    expect(screen.queryByText(/Without one, sessions run in/)).toBeNull();
    fireEvent.change(nameField(), { target: { value: "Cider App" } });
    expect(await screen.findByText("/home/work/cider-app")).toBeInTheDocument();
    expect(screen.getByText(/Without one, sessions run in/)).toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: "Cider App 2" } });
    expect(await screen.findByText("/home/work/cider-app-2")).toBeInTheDocument();
    expect(api.calls).toContain("spaceFolderFor:p1:Cider App 2");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(screen.getByText("/tmp/picked-repo")).toBeInTheDocument());
    expect(screen.queryByText(/Without one, sessions run in/)).toBeNull();
  });

  it("a chosen folder names the space when nothing is typed, becomes its first project, and is where its session works", async () => {
    const { store, api } = await mount();
    expect(create()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(screen.getByText("/tmp/picked-repo")).toBeInTheDocument());
    expect(nameField()).toHaveAttribute("placeholder", "picked-repo");
    expect(create()).toBeEnabled();
    fireEvent.click(create());
    await waitFor(() => expect(store.getState().spaces.some((x) => x.name === "picked-repo")).toBe(true));
    const made = store.getState().spaces.find((x) => x.name === "picked-repo")!;
    await waitFor(() => expect(Object.values(store.getState().sessions).some((x) => x.spaceId === made.id)).toBe(true));
    const project = api.data.projects[made.id]![0]!;
    expect(project.rootPath).toBe("/tmp/picked-repo");
    expect(Object.values(store.getState().sessions).find((x) => x.spaceId === made.id)!.projectId).toBe(project.id);
  });

  it("takes a folder dropped from the Finder, and lets it go again", async () => {
    const { store, api } = await mount();
    const zone = screen.getByRole("button", { name: "Choose folder…" }).parentElement!;
    const dir = Object.assign(new File([], "versed", { type: "" }), { path: "/Users/me/code/versed" });
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [dir], dropEffect: "none" } });
    expect(screen.getByText("/Users/me/code/versed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove folder" }));
    expect(screen.queryByText("/Users/me/code/versed")).toBeNull();
    fireEvent.change(nameField(), { target: { value: "No folder" } });
    fireEvent.click(create());
    await waitFor(() => expect(store.getState().spaces.some((x) => x.name === "No folder")).toBe(true));
    expect(api.data.projects[store.getState().spaces.find((x) => x.name === "No folder")!.id] ?? []).toEqual([]);
  });

  it("makes the space in the profile picked, and the window follows it there", async () => {
    const { store } = await mount();
    fireEvent.change(nameField(), { target: { value: "Homework 2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "p2" } });
    fireEvent.click(create());
    await waitFor(() => expect(store.getState().spaces.some((s) => s.name === "Homework 2")).toBe(true));
    expect(store.getState().spaces.find((s) => s.name === "Homework 2")!.profileId).toBe("p2");
    await waitFor(() => expect(store.getState().activeProfileId).toBe("p2"));
  });

  it("'New profile…' is the profile list's last row: it opens a field in place that makes the profile and picks it", async () => {
    const { store, api } = await mount();
    expect(screen.queryByRole("textbox", { name: "New profile name" })).toBeNull();
    const select = screen.getByRole("combobox", { name: "Profile" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Work", "School", "New profile…"]);
    fireEvent.change(select, { target: { value: "new-profile" } });
    const input = screen.getByRole("textbox", { name: "New profile name" });
    expect(document.activeElement).toBe(input);
    // The row is not a profile: the list still says which one the space is going into.
    expect(select.value).toBe("p1");
    fireEvent.change(input, { target: { value: "Side projects" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().profiles.map((p) => p.name)).toContain("Side projects"));
    const made = store.getState().profiles.find((p) => p.name === "Side projects")!;
    await waitFor(() => expect(select.value).toBe(made.id));
    expect(screen.queryByRole("textbox", { name: "New profile name" })).toBeNull();
    expect(api.calls).toContain("createProfile:Side projects");
    // Enter in that field made the profile, and nothing else.
    expect(store.getState().sheet?.kind).toBe("new-space");
  });

  it("with zero profiles: explains why Create is disabled instead of failing silently, and the inline profile unlocks it", async () => {
    const { store } = await mount(fakeApi({ profiles: [], spaces: [], items: {} }));
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: "Versed" } });
    expect(create()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "New profile name" }), { target: { value: "Personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(store.getState().profiles.map((p) => p.name)).toEqual(["Personal"]));
    expect(screen.queryByText(/no profiles yet/i)).not.toBeInTheDocument();
    expect(create()).toBeEnabled();
    fireEvent.click(create());
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(store.getState().spaces[0]!.profileId).toBe(store.getState().profiles[0]!.id);
  });

  it("an icon from one profile's library does not follow the space into another profile", async () => {
    /* Generated and uploaded icons are filed per profile and drawn from that profile's library, so
       one carried into another profile's space draws as the folder glyph wherever that library is
       not loaded. THE mutant keeps the pick across the switch. */
    const { store } = await mount(fakeApi({ iconAssets: { p1: [iconAsset("a1", "p1")] } }));
    fireEvent.click(tile());
    fireEvent.click(screen.getByRole("tab", { name: "Generated" }));
    fireEvent.click(await screen.findByRole("radio", { name: "a circle" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "p2" } });
    fireEvent.change(nameField(), { target: { value: "Elsewhere" } });
    fireEvent.click(create());
    await waitFor(() => expect(store.getState().spaces.some((x) => x.name === "Elsewhere")).toBe(true));
    expect(store.getState().spaces.find((x) => x.name === "Elsewhere")!.icon).toBe("folder");
  });

  it("memory is one line until asked for; Write… opens the field with the keyboard, and what is typed is the space's memory", async () => {
    const { store, api } = await mount();
    expect(screen.queryByRole("textbox", { name: "Memory" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Write…" }));
    const field = screen.getByRole("textbox", { name: "Memory" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Use pnpm." } });
    fireEvent.change(nameField(), { target: { value: "Remembers" } });
    // ⌘↩ from the paragraph creates, as it sends in the prompter.
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(store.getState().spaces.some((x) => x.name === "Remembers")).toBe(true));
    const made = store.getState().spaces.find((x) => x.name === "Remembers")!;
    await waitFor(() => expect(api.calls).toContain(`setMemory:${made.id}:${"Use pnpm.".length}`));
  });

  it("says beside Create what it does: the space opens on a new session, on the agent last used", async () => {
    const { store } = await mount();
    expect(screen.getByText("Opens on a new Claude session.")).toBeInTheDocument();
    act(() => store.setState({ lastAgentKind: "codex" }));
    expect(screen.getByText("Opens on a new Codex session.")).toBeInTheDocument();
  });

  it("Escape in the icon picker closes the picker and leaves the sheet up; Escape again closes the sheet", async () => {
    const { store } = await mount();
    fireEvent.click(tile());
    // The picker's search takes the keyboard once it is placed, so a name can be typed into it at once.
    const search = await screen.findByRole("textbox", { name: "Search" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    // The picker listens from the tick after it opened, so the click that opened it cannot close it.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull());
    expect(store.getState().sheet?.kind).toBe("new-space");
    // Opened again with the keyboard left on the tile, as a press on it leaves it: still the picker's.
    fireEvent.click(tile());
    await screen.findByRole("dialog", { name: "Choose an icon" });
    await new Promise((r) => setTimeout(r, 0));
    tile().focus();
    fireEvent.keyDown(tile(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull());
    expect(store.getState().sheet?.kind).toBe("new-space");
    fireEvent.keyDown(nameField(), { key: "Escape" });
    expect(store.getState().sheet).toBeNull();
  });
});

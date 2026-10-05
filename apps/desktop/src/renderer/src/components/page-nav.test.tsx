import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
/* The pane components register themselves by side effect (`panes/index.ts`); the overlay renders
   through the same registry, so a test that never imports them gets the placeholder. */
import "../panes";
import { PageOverlay } from "./PageOverlay";
import { PageNavProvider } from "./page-nav";
import { Sidebar } from "./sidebar/Sidebar";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, skillRow, type FakeData } from "../state/store.test-fakes";

/**
 * A page's own sections in the sidebar's place (page-nav.tsx): over the panes, Settings, the Library,
 * a profile's and a space's page draw their rail in the sidebar's column — the spaces hidden under a
 * Back — instead of standing beside it as a second sidebar. Every test names the change that would
 * make it fail.
 */
async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(
    <StoreContext.Provider value={store}>
      <PageNavProvider>
        <Sidebar collapsed={store.getState().sidebarCollapsed} />
        <PageOverlay />
      </PageNavProvider>
    </StoreContext.Provider>,
  );
  return { api, store, ...r };
}

const sidebar = () => document.getElementById("app-sidebar")!;
const page = () => document.querySelector(".page-overlay")!;
const open = (store: Awaited<ReturnType<typeof mount>>["store"], kind: "library-page" | "settings-page" | "you-page") =>
  act(() => { store.getState().openDestinationPage(kind); });

afterEach(() => cleanup());

describe("a page's rail in the sidebar's place", () => {
  it("draws the Library's sections in the sidebar, under a Back, with the spaces hidden — and none in the page", async () => {
    // THE MUTANTS: leave the rail in the page (two sidebars), or draw it in the sidebar beside the
    // spaces rather than in their place.
    const { store } = await mount();
    await open(store, "library-page");
    const side = within(sidebar());
    await waitFor(() => expect(side.getByRole("radio", { name: "Files" })).toBeInTheDocument());
    expect(side.getByRole("radio", { name: "Skills" })).toBeInTheDocument();
    expect(side.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(sidebar().querySelector(".sb-list")).toHaveAttribute("hidden");
    // Back stands where the profile does, at the head of what the column lists — and the profile
    // goes with the spaces it names.
    expect(side.getByRole("button", { name: "Back" }).closest(".sb-page-head")).not.toBeNull();
    expect(side.queryByRole("button", { name: /^Profile:/ })).toBeNull();
    expect(side.queryByRole("button", { name: "New space" })).toBeNull();
    expect(page().querySelector(".page-rail")).toBeNull();
    expect(within(page() as HTMLElement).queryByRole("radio", { name: "Files" })).toBeNull();
  });

  it("is still the page's rail: a section picked in the sidebar is the section the page shows", async () => {
    const { store } = await mount();
    await open(store, "library-page");
    const skills = await within(sidebar()).findByRole("radio", { name: "Skills" });
    fireEvent.click(skills);
    await waitFor(() => expect(skills).toBeChecked());
    // The Skills panel's own details block, in the page: the section the rail chose is the one drawn.
    await waitFor(() => expect(page().querySelector(".skills-details")).not.toBeNull());
    expect(within(sidebar()).getByRole("radio", { name: "Files" })).not.toBeChecked();
  });

  it("Back closes the page and gives the sidebar its spaces back", async () => {
    // THE MUTANT: a Back that only swaps the column, leaving the page open with its rail gone.
    const { store } = await mount();
    await open(store, "library-page");
    fireEvent.click(await within(sidebar()).findByRole("button", { name: "Back" }));
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
    expect(sidebar().querySelector(".sb-list")).not.toHaveAttribute("hidden");
    expect(sidebar().querySelector(".sb-page")).toBeNull();
    expect(within(sidebar()).getByRole("button", { name: "New space" })).toBeInTheDocument();
  });

  it("leaves the sidebar alone for a page with no rail of its own", async () => {
    // THE MUTANT: hand the column over for every page — the page about you has nothing to put there.
    const { store } = await mount();
    await open(store, "you-page");
    await screen.findByRole("dialog", { name: "You" });
    expect(sidebar().querySelector(".sb-page")).toBeNull();
    expect(sidebar().querySelector(".sb-list")).not.toHaveAttribute("hidden");
  });

  it("keeps the rail in the page while the sidebar is collapsed, where it can still be reached", async () => {
    // THE MUTANT: portal into a column that is off the window and inert.
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } });
    expect(store.getState().sidebarCollapsed).toBe(true);
    await open(store, "library-page");
    await waitFor(() => expect(within(page() as HTMLElement).getByRole("radio", { name: "Files" })).toBeInTheDocument());
    expect(sidebar().querySelector(".sb-page")).toBeNull();
  });

  it("moves Settings' search with its pages, and what it finds is listed in the page", async () => {
    const { store } = await mount();
    await open(store, "settings-page");
    const search = await within(sidebar()).findByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "theme" } });
    await waitFor(() => expect(within(page() as HTMLElement).getAllByRole("button").length).toBeGreaterThan(0));
    expect(page().querySelector(".page-rail")).toBeNull();
  });

  it("keeps the Library's sections in the sidebar while a skill is read, Skills lit — and Files leaves the skill", async () => {
    // THE MUTANTS: give the column back while a skill is open (the sidebar flips under the reader),
    // or let a section picked there leave the skill on screen.
    const { store } = await mount({ skills: { s1: [skillRow("sk1", { name: "Review" })] } });
    const spaceId = store.getState().activeSpaceId!;
    await open(store, "library-page");
    act(() => { store.getState().setLibrarySkill(spaceId, "sk1"); });
    const skills = await within(sidebar()).findByRole("radio", { name: "Skills" });
    expect(skills).toBeChecked();
    expect(page().querySelector(".page-rail:not(.skill-toc)")).toBeNull();
    fireEvent.click(within(sidebar()).getByRole("radio", { name: "Files" }));
    await waitFor(() => expect(store.getState().librarySkill[spaceId] ?? null).toBeNull());
    expect(within(sidebar()).getByRole("radio", { name: "Files" })).toBeChecked();
  });
});

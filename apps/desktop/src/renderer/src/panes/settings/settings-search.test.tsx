import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS, PAGE_REF_IDS } from "@realm/contracts";

/** The Keys page reads its file over the socket rather than through the store, so the socket is the
 *  seam — answered with Realm's own rules, which is what a fresh home has. */
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string) => {
      if (method === "keybindings.get") return { path: "/realm-home/keybindings.json", rules: [...DEFAULT_KEYBINDINGS], error: null };
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { SettingsPage } from "./SettingsPage";
import { SETTINGS_GROUPS, SETTINGS_INDEX, searchSettings, type SettingsTab } from "./settings-index";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";
import type { AgentProbe } from "../../state/store";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });
const probe: AgentProbe[] = [{ kind: "claude", available: true, version: "2.1.223", loggedIn: null, reason: null }];

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({ agentProbe: probe, ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

const search = () => screen.getByRole("searchbox", { name: "Search settings" });
const type = (q: string) => fireEvent.change(search(), { target: { value: q } });
const results = () => within(screen.getByRole("list", { name: "Matching settings" }));
const rail = () => document.querySelector(".page-rail") as HTMLElement;

describe("the rail is grouped", () => {
  it("lists each page under its heading, in the plan's order", async () => {
    // THE flat-rail mutant: seven equal tabs again. Each heading has to be a group of exactly its own
    // pages, or "You" is a label floating over whatever happens to follow it.
    await mount();
    const seen = SETTINGS_GROUPS.map((g) => [g.label, within(screen.getByRole("group", { name: g.label }))
      .getAllByRole("radio").map((r) => r.closest("label")!.textContent)]);
    expect(seen).toEqual([
      ["You", ["General", "Appearance", "Keys", "Notifications"]],
      ["Engines", ["Engines", "Usage"]],
      ["Browser", ["Sign-ins"]],
      ["Computer", ["Permissions", "Computer use"]],
      ["Data", ["Import", "Archived"]],
    ]);
  });

  it("is still one choice across the headings, so one page is lit at a time", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Usage" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Usage" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "General" })).not.toBeChecked();
    expect(rail().querySelectorAll("[data-selected]")).toHaveLength(1);
  });

  it("opens each page at its own top, not where the last one was left", async () => {
    // THE shared-scroller mutant: one column for every page, so General opens as far down as
    // Appearance was left — which a jump to a row near the foot of a page makes the common case.
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Appearance" }));
    const column = () => document.querySelector(".page-content") as HTMLElement;
    column().scrollTop = 300;
    fireEvent.click(screen.getByRole("radio", { name: "General" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "General" })).toBeChecked());
    expect(column().scrollTop).toBe(0);
  });

  it("puts the search at the top of the rail, above the first heading", async () => {
    await mount();
    const field = search();
    expect(rail().contains(field)).toBe(true);
    expect(field.compareDocumentPosition(screen.getByRole("group", { name: "You" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("searching", () => {
  it("shows the rows a query names in place of the page, each with where it lives", async () => {
    await mount();
    expect(screen.getByRole("switch", { name: "Ask before deleting" })).toBeInTheDocument();
    type("font");
    // THE inert-search mutant: a field that filters nothing. The page under it would still be General.
    expect(screen.queryByRole("switch", { name: "Ask before deleting" })).toBeNull();
    expect(results().getByRole("button", { name: "UI font, in Appearance ▸ Text" })).toBeInTheDocument();
    expect(results().getByRole("button", { name: "Code font, in Appearance ▸ Text" })).toBeInTheDocument();
  });

  it("finds a row by its section as well as its label", async () => {
    // THE label-only mutant: "terminals" matches no row's label word, only the heading they sit under.
    await mount();
    type("terminals");
    const found = results().getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(found).toEqual([
      "Keep terminal scrollback, in General ▸ Terminals",
      "Blink the terminal cursor, in General ▸ Terminals",
      "Terminal cursor, in General ▸ Terminals",
      "Session terminal, in General ▸ Terminals",
      "Terminal colours, in General ▸ Terminals",
    ]);
  });

  it("finds a row by the words people use for it, which its label does not contain", async () => {
    // THE terms-dropped mutant: "dark mode" names the Theme row and appears nowhere on it.
    await mount();
    type("dark mode");
    expect(results().getByRole("button", { name: "Theme, in Appearance" })).toBeInTheDocument();
  });

  it("matches the starts of words, not any run of letters inside them", async () => {
    // THE substring mutant: "ine" is inside "Line height", "Engines" and "Blink the editor caret",
    // and a field that offered all three for it would be offering noise.
    await mount();
    type("ine");
    expect(screen.getByText("No setting matches “ine”.")).toBeInTheDocument();
    type("sign in");
    expect(results().getByRole("button", { name: "Saved sign-ins, in Sign-ins" })).toBeInTheDocument();
  });

  it("ranks rows whose label holds the words first, then their page or section, then their terms", () => {
    // "permission" is a label word of one row, the page of two, and a term of one. THE unranked
    // mutant: page order, which puts the term-only match — General's default mode — first.
    expect(searchSettings("permission").map((e) => e.id))
      .toEqual(["notify:permission", "mac-apps", "realm-access", "default-permission"]);
  });

  it("lights no page while results stand in for one, and a page clicked gives the column back", async () => {
    await mount();
    type("font");
    // THE lit-tab mutant: General stays checked over a column that is not General.
    expect(rail().querySelectorAll("input[type=radio]:checked")).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: "Notifications" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Notifications" })).toBeChecked());
    expect((search() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("switch", { name: "Notify me outside Realm" })).toBeInTheDocument();
  });

  it("Escape clears the query and puts the page back", async () => {
    await mount();
    type("font");
    fireEvent.keyDown(search(), { key: "Escape" });
    expect((search() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("switch", { name: "Ask before deleting" })).toBeInTheDocument();
  });
});

describe("a result jumps to its row", () => {
  it("opens the row's page, takes focus to its control, and marks it", async () => {
    await mount();
    type("contrast");
    fireEvent.click(results().getByRole("button", { name: "Contrast, in Appearance" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Appearance" })).toBeChecked());
    const slider = screen.getByRole("slider", { name: "Contrast" });
    // THE scroll-only mutant: land without moving focus, and the keyboard is left on a button that
    // no longer exists.
    await waitFor(() => expect(slider).toHaveFocus());
    expect(slider.closest(".settings-row")).toHaveAttribute("data-found");
    expect((search() as HTMLInputElement).value).toBe("");
  });

  it("the mark goes again, so a row is not left looking selected", async () => {
    await mount();
    type("contrast");
    fireEvent.click(results().getByRole("button", { name: "Contrast, in Appearance" }));
    const row = () => screen.getByRole("slider", { name: "Contrast" }).closest(".settings-row")!;
    await waitFor(() => expect(row()).toHaveAttribute("data-found"));
    // THE sticky-mark mutant: never take it off, and the last search leaves an accent edge on a row
    // for the rest of the visit.
    await waitFor(() => expect(row()).not.toHaveAttribute("data-found"), { timeout: 3000 });
  });

  it("Enter takes the first result", async () => {
    await mount();
    type("ask before");
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Ask before deleting" })).toHaveFocus());
  });

  it("waits for a row its page draws late", async () => {
    // The budget is drawn once the page's usage read lands. THE give-up mutant: look once, find the
    // page still loading, and leave the reader at the top of it.
    const { api } = await mount();
    api.delays.usageSummary = 80;
    type("budget");
    fireEvent.click(results().getByRole("button", { name: "Monthly budget, in Usage" }));
    const card = () => document.querySelector('[data-setting="usage-budget"]');
    expect(card()).toBeNull();
    await waitFor(() => expect(card()?.contains(document.activeElement)).toBe(true));
  });

  it("opens a row folded behind a disclosure, because landing on a closed summary has found nothing", async () => {
    // jsdom has no colour scheme, so the light face is the live one and the dark face is folded.
    await mount();
    const fold = () => document.querySelector('[data-setting="palette-dark"] details') as HTMLDetailsElement;
    fireEvent.click(screen.getByRole("radio", { name: "Appearance" }));
    expect(fold().open).toBe(false);
    type("dark theme");
    fireEvent.click(results().getByRole("button", { name: "Dark theme, in Appearance" }));
    await waitFor(() => expect(fold().open).toBe(true));
  });

  it("a page that is a report rather than rows opens at its top", async () => {
    await mount();
    type("import");
    fireEvent.click(results().getByRole("button", { name: "Import from the agent CLIs, in Import" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Import" })).toBeChecked());
  });
});

/**
 * The index is written out, so this is what keeps it true: render every page and compare. A row
 * added to a page without an entry is a setting search cannot find; an entry whose row is gone is a
 * result that lands nowhere.
 */
describe("the index and the pages agree", () => {
  const PAGES = SETTINGS_GROUPS.flatMap((g) => g.tabs);
  const label = (tab: SettingsTab) => PAGES.find((t) => t.id === tab)!.label;

  for (const { id: tab } of PAGES) {
    it(`${label(tab)}: every entry is on the page, and every anchor on it is an entry`, async () => {
      await mount();
      fireEvent.click(screen.getByRole("radio", { name: label(tab) }));
      const content = document.querySelector(".page-content") as HTMLElement;
      const wanted = SETTINGS_INDEX.filter((e) => e.tab === tab && !e.page && e.available?.() !== false).map((e) => e.id);
      await waitFor(() => {
        const present = new Set([...content.querySelectorAll("[data-setting]")].map((el) => el.getAttribute("data-setting")));
        for (const id of wanted) expect(present.has(id), `${tab}: no row carries "${id}"`).toBe(true);
      });
      const indexed = new Set(SETTINGS_INDEX.map((e) => e.id));
      for (const el of content.querySelectorAll("[data-setting]")) {
        expect(indexed.has(el.getAttribute("data-setting")!), `"${el.getAttribute("data-setting")}" is on ${tab} and not in the index`).toBe(true);
      }
    });
  }

  it("every row the old App tab drew is in the index — none was left out of the split", async () => {
    await mount();
    for (const page of ["General", "Appearance", "Notifications"]) {
      fireEvent.click(screen.getByRole("radio", { name: page }));
      await screen.findAllByRole("switch");
      await waitFor(() => expect(document.querySelector(".page-content .env-empty")).toBeNull());
      const bare = [...document.querySelectorAll(".page-content .settings-row:not([data-setting])")]
        .map((r) => r.querySelector(".settings-row-name")?.textContent ?? r.textContent);
      expect(bare, `${page}: rows no search can find`).toEqual([]);
    }
  });

  it("no two entries share an id, so a jump has one row to land on", () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a row the platform may not have", () => {
  afterEach(() => { delete (window as { realm?: unknown }).realm; });

  it("App icon is found only where there is a Dock to put it on", () => {
    expect(searchSettings("dock").map((e) => e.id)).not.toContain("app-icon");
    Object.assign(window, { realm: { appIcon: { get: async () => "default", set: async () => true } } });
    expect(searchSettings("dock").map((e) => e.id)).toContain("app-icon");
  });
});

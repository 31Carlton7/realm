import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, REDUCED_MOTION_KEY, type BackgroundImage } from "@realm/contracts";
import { CODE_SIZE_RANGE, DEFAULT_PANE_ALPHA, PANE_ALPHA_RANGE, UI_SIZE_RANGE, paneAlphaFromGround } from "@realm/ui";
import { SettingsPage } from "./SettingsPage";
import { GALLERY } from "../session/backdrop-gallery";
import { SETTING_PANE_ALPHA, StoreContext, createAppStore } from "../../state/store";
import { resetYourBackgrounds } from "../../state/your-backgrounds";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

async function appearance(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Appearance" }));
  return { api, store, ...r };
}

const motion = () => within(screen.getByRole("group", { name: "Reduce motion" }));

describe("Reduce motion", () => {
  it("follows the system until someone chooses, and tells the window as soon as they do", async () => {
    const { api, store } = await appearance();
    expect(motion().getByRole("radio", { name: "System" })).toBeChecked();
    fireEvent.click(motion().getByRole("radio", { name: "On" }));
    await waitFor(() => expect(store.getState().reduceMotion).toBe("on"));
    // THE stored-only mutant: write the key and never tell main, so nothing moves until a relaunch.
    expect(api.calls).toContain("setReducedMotion:on");
    expect(api.calls).toContain(`setSetting:${REDUCED_MOTION_KEY}=on`);
  });

  it("asks the window for the saved answer on every launch, and reads a value it does not know as System", async () => {
    // The window keeps the override on its own session; a launch is what puts the saved one back.
    const { api } = await appearance({ settings: { [REDUCED_MOTION_KEY]: "off" } });
    expect(api.calls).toContain("setReducedMotion:off");
    expect(motion().getByRole("radio", { name: "Off" })).toBeChecked();
    const junk = await (async () => { const a = fakeApi({ settings: { [REDUCED_MOTION_KEY]: "always" } }); const st = createAppStore(a); await st.getState().boot(); return st; })();
    expect(junk.getState().reduceMotion).toBe("system");
  });
});

describe("Sidebar and pane translucency", () => {
  it("are two controls over two numbers — moving one leaves the other where it was", async () => {
    vi.stubGlobal("realm", { platform: "darwin" });
    try {
      const { api, store } = await appearance();
      const before = store.getState().groundAlpha;
      // 6 on a slider that reads as transparency is 94% opaque on a range of 0–100.
      fireEvent.change(screen.getByRole("slider", { name: "Pane transparency" }), { target: { value: "6" } });
      await waitFor(() => expect(store.getState().paneAlpha).toBe(94));
      // THE one-control mutant: the pane's slider writes the sidebar's number again.
      expect(store.getState().groundAlpha).toBe(before);
      await waitFor(() => expect(api.calls).toContain(`setSetting:${SETTING_PANE_ALPHA}=94`));
      fireEvent.click(screen.getByRole("switch", { name: "Sidebar translucency" }));
      await waitFor(() => expect(store.getState().groundAlpha).toBe(100));
      expect(store.getState().paneAlpha).toBe(94);
    } finally { vi.unstubAllGlobals(); }
  });

  it("the pane's control runs the whole way, and its readout is the pane's own", async () => {
    vi.stubGlobal("realm", { platform: "darwin" });
    try {
      const { store } = await appearance();
      const slider = screen.getByRole("slider", { name: "Pane transparency" }) as HTMLInputElement;
      expect([slider.min, slider.max]).toEqual([String(PANE_ALPHA_RANGE.min), String(PANE_ALPHA_RANGE.max)]);
      // At the default the pane is wholly see-through (11-17): a number about the pane, not the sidebar's 45.
      expect(DEFAULT_PANE_ALPHA).toBe(0);
      expect(within(slider.closest(".settings-row") as HTMLElement).getByText(`${100 - DEFAULT_PANE_ALPHA}%`)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("switch", { name: "Pane translucency" }));
      await waitFor(() => expect(store.getState().paneAlpha).toBe(100));
      expect(screen.getByRole("slider", { name: "Pane transparency" })).toBeDisabled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("a home saved under one control keeps the panes it had, and stops following the sidebar after", async () => {
    /* The previous schema, by hand: the sidebar's number and no pane number at all. THE read-only
       carry-over mutant: derive the pane on every boot without writing it, and the panes go on
       following the sidebar on every launch until someone happens to touch their slider. */
    const api = fakeApi({ settings: { "ui.groundAlpha": 70 } });
    const store = createAppStore(api);
    await store.getState().boot();
    expect(store.getState().paneAlpha).toBe(paneAlphaFromGround(70));
    await waitFor(() => expect(api.data.settings[SETTING_PANE_ALPHA]).toBe(paneAlphaFromGround(70)));
    // Idempotent: a second launch on the same home finds the pane's own number and writes nothing.
    const writes = () => api.calls.filter((c) => c.startsWith(`setSetting:${SETTING_PANE_ALPHA}=`)).length;
    const first = writes();
    const again = createAppStore(api);
    await again.getState().boot();
    expect(writes()).toBe(first);
    // A fresh home has nothing to carry: the default, and no write.
    const fresh = fakeApi({});
    const st = createAppStore(fresh);
    await st.getState().boot();
    expect(st.getState().paneAlpha).toBe(DEFAULT_PANE_ALPHA);
    expect(fresh.calls.some((c) => c.startsWith(`setSetting:${SETTING_PANE_ALPHA}=`))).toBe(false);
  });

  it("starts a home that never moved the slider at the see-through end, and keeps a value set by hand", async () => {
    /* The setting is stored only when someone moves the control, so an unset key IS "never moved".
       THE mutants: the default left on the reading's 84, or a stored value overwritten at boot to
       carry the new default to everyone. 84 by hand is the old default chosen on purpose and stays. */
    const fresh = fakeApi({});
    const st = createAppStore(fresh);
    await st.getState().boot();
    expect(st.getState().paneAlpha).toBe(0);
    for (const kept of [84, 60, 100]) {
      const api = fakeApi({ settings: { [SETTING_PANE_ALPHA]: kept } });
      const store = createAppStore(api);
      await store.getState().boot();
      expect(store.getState().paneAlpha).toBe(kept);
      expect(api.calls.some((c) => c.startsWith(`setSetting:${SETTING_PANE_ALPHA}=`))).toBe(false);
    }
  });
});

describe("Text sizes and the content face", () => {
  it("UI and code font size are px sliders over their own ranges, each writing only its own field", async () => {
    const { store, api } = await appearance();
    const ui = screen.getByRole("slider", { name: "UI font size" }) as HTMLInputElement;
    const code = screen.getByRole("slider", { name: "Code font size" }) as HTMLInputElement;
    expect([ui.min, ui.max, ui.value]).toEqual([UI_SIZE_RANGE.min, UI_SIZE_RANGE.max, UI_SIZE_RANGE.default].map(String));
    expect([code.min, code.max, code.value]).toEqual([CODE_SIZE_RANGE.min, CODE_SIZE_RANGE.max, CODE_SIZE_RANGE.default].map(String));
    fireEvent.change(ui, { target: { value: "16" } });
    await waitFor(() => expect(store.getState().fonts.uiSize).toBe(16));
    // The readout is the size, in px, beside the control that set it.
    expect(within(ui.closest(".settings-row") as HTMLElement).getByText("16px")).toBeInTheDocument();
    // THE shared-size mutant: one number for both, and bigger prose drags the code with it.
    expect(store.getState().fonts.codeSize).toBe(CODE_SIZE_RANGE.default);
    fireEvent.change(code, { target: { value: "14" } });
    await waitFor(() => expect(store.getState().fonts.codeSize).toBe(14));
    expect(store.getState().fonts.uiSize).toBe(16);
    expect(api.calls.some((c) => c.startsWith("setSetting:ui.fonts"))).toBe(true);
  });

  it("the content face is its own choice, offers a serif, and starts as the UI face", async () => {
    const { store } = await appearance();
    const select = screen.getByRole("combobox", { name: "Content font" }) as HTMLSelectElement;
    expect(select.value).toBe("bundled");
    expect([...select.options].slice(0, 3).map((o) => o.textContent)).toEqual(["Same as UI font", "System serif", "System default"]);
    fireEvent.change(select, { target: { value: "serif" } });
    await waitFor(() => expect(store.getState().fonts.content).toBe("serif"));
    expect(store.getState().fonts.ui).toBe("bundled");
    // THE unknown-reserved-word mutant: treat "serif" as a family that is missing, and the select
    // grows a "serif — not installed" row for a face it just offered.
    expect([...select.options].some((o) => /not installed/.test(o.textContent ?? ""))).toBe(false);
  });
});

describe("Cursor", () => {
  it("carries a home's old answers into the new controls: a stilled editor caret, and a terminal set to a bar", async () => {
    /* THE ignored-history mutant: read neither old key, and someone who had stopped the code editor's
       caret and given their terminals a bar opens v2 to a blinking caret and a blinking block. */
    const { store } = await appearance({ settings: { "editor.cursorBlink": false, "terminals.cursorStyle": "bar" } });
    expect(store.getState().caret.animation).toBe("solid");
    expect(store.getState().terminalCursorStyle).toBe("line");
    expect(within(screen.getByRole("group", { name: "Terminal cursor" })).getByRole("radio", { name: "Line" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Cursor animation" })).toHaveValue("solid");
  });

  it("says every cursor is holding still while Reduce motion has it so, and nothing otherwise", async () => {
    // THE silent-request mutant (design.md): the menu reads Smooth fade while the window draws a caret
    // that does not move, and nothing on the page says why.
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      await appearance({ settings: { "ui.caret": { animation: "smooth" } } });
      expect(screen.getByText("Reduce motion is on, so every cursor holds still.")).toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
    cleanup();
    await appearance({ settings: { "ui.caret": { animation: "smooth" } } });
    expect(screen.queryByText(/holds still/)).toBeNull();
  });

  it("under Low power says an eased cursor blinks instead, and says nothing for a cursor that already blinks", async () => {
    await appearance({ settings: { "ui.caret": { animation: "pulse" }, "ui.lowPower": true } });
    expect(screen.getByText("Low power is on, so the cursor blinks instead.")).toBeInTheDocument();
    expect(screen.queryByText(/holds still/)).toBeNull();
    cleanup();
    await appearance({ settings: { "ui.caret": { animation: "blink" }, "ui.lowPower": true } });
    expect(screen.queryByText(/blinks instead/)).toBeNull();
  });
});

describe("Background", () => {
  const grid = () => within(screen.getByRole("group", { name: "Background" }));

  it("shows the default painting chosen, saves a pick, and offers Motion only for a look that moves", async () => {
    const { api, store } = await appearance();
    expect(grid().getByRole("radio", { name: "Sky and Cliffs" })).toBeChecked();
    expect(grid().getAllByRole("radio").map((r) => (r as HTMLInputElement).value).slice(0, 2)).toEqual(["off", "shuffle"]);
    expect(screen.getByRole("switch", { name: "Background motion" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: `Show all ${GALLERY.length + 2}` }));
    fireEvent.click(grid().getByRole("radio", { name: "Haze, moves" }));
    await waitFor(() => expect(store.getState().background).toBe("haze"));
    expect(api.calls).toContain("setSetting:ui.background=haze");
    expect(screen.getByRole("switch", { name: "Background motion" })).toBeEnabled();
    fireEvent.click(grid().getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(store.getState().background).toBe("off"));
    // The chosen painting names its maker, and every shipped picture is credited.
    fireEvent.click(grid().getByRole("radio", { name: "Northern Cuba" }));
    await waitFor(() => expect(screen.getByTestId("background-credit").textContent).toMatch(/Brownell.*CC0/));
    expect(screen.getByText("Picture credits")).toBeInTheDocument();
    fireEvent.click(grid().getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(store.getState().background).toBe("off"));
    // No pictures yet: the empty state offers the way to add one.
    expect(screen.getByRole("button", { name: "Add image…" })).toBeInTheDocument();
  });

  it("marks a look that moves on its tile and in its name, and no still one", async () => {
    // THE MUTANTS: the mark drawn on every tile, or on none; the mark only seen, never said.
    await appearance();
    const tile = (name: string) => grid().getByRole("radio", { name }).closest("label")!;
    expect(tile("Sunlit Reef, moves").querySelector(".backdrop-moves")).not.toBeNull();
    expect(tile("Sky and Cliffs").querySelector(".backdrop-moves")).toBeNull();
    expect(document.querySelectorAll(".backdrop-moves")).toHaveLength(GALLERY.filter((g) => g.motion).length);
  });

  it("folds the looks after three rows and keeps the chosen one among them", async () => {
    await appearance({ settings: { "ui.background": "synth-coast" } });
    const shown = document.querySelector('[aria-label="Background"] > .backdrop-grid')!;
    expect([...shown.querySelectorAll("input")].map((r) => r.value)).toEqual(["off", "shuffle", "synth-coast"]);
    expect(grid().getByRole("radio", { name: "Synth Coast, moves" })).toBeChecked();
  });
});

describe("Your images", () => {
  const image = (n: number): BackgroundImage => ({
    id: `p${n}`, name: `Picture ${n}`, added: n, effect: "dither-color", asIs: false, width: 1600, height: 1000, loop: null,
  });

  it("folds after three rows with Add image… always first, and keeps the chosen one among them", async () => {
    // THE MUTANTS: Add image… drawn last, where Show all folds it away; the chosen picture left folded.
    const pictures = [1, 2, 3, 4, 5, 6, 7].map(image);
    resetYourBackgrounds();
    vi.stubGlobal("realm", { platform: "darwin", backgrounds: { list: async () => pictures, image: async () => null } });
    try {
      await appearance({ settings: { "ui.background": "mine:p6" } });
      const mine = await screen.findByRole("group", { name: "Your images" });
      const shown = mine.querySelector(":scope > .backdrop-grid")!;
      expect(shown.firstElementChild).toBe(within(mine).getByRole("button", { name: "Add image…" }));
      expect([...shown.querySelectorAll("input")].map((r) => r.value)).toEqual(["mine:p1", "mine:p6"]);
      expect(within(mine).getByRole("radio", { name: "Picture 6" })).toBeChecked();
      const row = mine.closest(".fold") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Show all 7" }));
      expect(within(row).getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
    } finally { cleanup(); resetYourBackgrounds(); vi.unstubAllGlobals(); }
  });
});

describe("Themes", () => {
  it("a chosen palette past the fold is in the rows shown, and the rest open under Show all", async () => {
    // THE MUTANT: a choice made elsewhere (an import, the prompter) left folded out of sight.
    await appearance({ settings: { "ui.themeName.dark": "rosepine" } });
    const dark = within(screen.getByRole("group", { name: "Dark theme" }));
    expect(dark.getByRole("radio", { name: "Rosé Pine" })).toBeChecked();
    const row = screen.getByRole("group", { name: "Dark theme" }).closest(".fold")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /^Show all \d+$/ }));
    expect(within(row as HTMLElement).getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
  });
});

describe("Import a theme", () => {
  const ayu = { label: "Ayu Dark", path: "/Users/me/.cursor/extensions/ayu/ayu-dark.json", mode: "dark" as const, editor: "Cursor" };
  const editorThemes = [
    ayu,
    { label: "Ayu Light", path: "/Users/me/.cursor/extensions/ayu/ayu-light.json", mode: "light" as const, editor: "Cursor" },
    { label: "Nord", path: "/Users/me/.vscode/extensions/nord/nord.json", mode: "dark" as const, editor: "VS Code" },
  ];
  const openMenu = async () => {
    const dark = screen.getByRole("group", { name: "Dark theme" }).closest(".settings-row") as HTMLElement;
    fireEvent.click(within(dark).getByRole("button", { name: "Import a theme" }));
    return within(await screen.findByRole("menu", { name: "Import a theme" }));
  };

  it("offers this face's installed themes by editor first, then a theme file, then one described", async () => {
    // THE MUTANTS: the other face's themes offered under this one; the editors' themes after the
    // rows that need typing; no way to name the editor a theme came from.
    await appearance({ editorThemes });
    const menu = await openMenu();
    expect(menu.getAllByRole("menuitem").map((r) => r.textContent)).toEqual(["Ayu Dark", "Nord", "Choose a theme file…", "Describe a theme…"]);
    expect(menu.getByRole("group", { name: "Cursor" })).toHaveTextContent("Ayu Dark");
    expect(menu.getByRole("group", { name: "VS Code" })).toHaveTextContent("Nord");
  });

  it("an installed theme opens a new session with its import already sent", async () => {
    // THE MUTANTS: the import left as a draft for the person to send; the session made without the path.
    const { api } = await appearance({ editorThemes });
    fireEvent.click((await openMenu()).getByRole("menuitem", { name: "Ayu Dark" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("sendMessage:"))).toBe(true));
    const sent = api.calls.filter((c) => c.startsWith("createSession:") || c.startsWith("sendMessage:"));
    expect(sent[0]).toMatch(/^createSession:/);
    expect(sent[1]).toMatch(new RegExp(`=Import the colour theme "Ayu Dark" from ${ayu.path} into Realm with theme_import`));
  });

  it("a theme file is picked first and nothing starts when the dialog is cancelled; one to describe waits in the prompter", async () => {
    const cancelled = await appearance({ pickedThemeFile: null });
    fireEvent.click((await openMenu()).getByRole("menuitem", { name: "Choose a theme file…" }));
    await waitFor(() => expect(cancelled.api.calls).toContain("pickThemeFile"));
    expect(cancelled.api.calls.some((c) => c.startsWith("createSession:"))).toBe(false);
    expect(cancelled.store.getState().toasts).toEqual([]); // a cancel is not a failure
    cleanup();

    const picked = await appearance({ pickedThemeFile: "/Users/me/Downloads/Dusk.json" });
    fireEvent.click((await openMenu()).getByRole("menuitem", { name: "Choose a theme file…" }));
    await waitFor(() => expect(picked.api.calls).toContainEqual(expect.stringMatching(/^sendMessage:.*=Import the colour theme "Dusk.json" from \/Users\/me\/Downloads\/Dusk.json/)));
    cleanup();

    const described = await appearance();
    fireEvent.click((await openMenu()).getByRole("menuitem", { name: "Describe a theme…" }));
    await waitFor(() => expect(described.store.getState().keyboardFor).not.toBeNull());
    const id = described.store.getState().keyboardFor!.sessionId;
    await waitFor(() => expect(described.store.getState().drafts[id]).toBe("Make me a colour theme for Realm and switch to it: "));
    expect(described.api.calls.some((c) => c.startsWith("sendMessage:"))).toBe(false);
  });

  it("the theme an agent imported is worn when its setting arrives, once the themes are read again", async () => {
    // THE MUTANTS: the window ignoring the key, so the theme shows only after a restart; the name set
    // without reading the themes again, which the registry does not hold, so the face stays on Realm's.
    const { api, store } = await appearance();
    await api.importTheme("/x/imported.json"); // what the agent's theme_import did on the server
    store.getState().applySettingChanged({ key: "ui.themeName.dark", value: "imported" });
    await waitFor(() => expect(store.getState().themeNames.dark).toBe("imported"));
    expect(store.getState().customThemes.map((t) => t.id)).toEqual(["imported"]);
    // A name for the other face, or none at all, changes nothing.
    store.getState().applySettingChanged({ key: "ui.themeName.light", value: "imported" });
    store.getState().applySettingChanged({ key: "ui.themeName.light", value: 7 });
    await waitFor(() => expect(api.calls.filter((c) => c === "listThemes").length).toBeGreaterThanOrEqual(3));
    expect(store.getState().themeNames.light).not.toBe("imported");
  });
});

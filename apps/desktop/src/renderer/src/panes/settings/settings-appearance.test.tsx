import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, REDUCED_MOTION_KEY } from "@realm/contracts";
import { CODE_SIZE_RANGE, DEFAULT_PANE_ALPHA, PANE_ALPHA_RANGE, UI_SIZE_RANGE, paneAlphaFromGround } from "@realm/ui";
import { SettingsPage } from "./SettingsPage";
import { SETTING_PANE_ALPHA, StoreContext, createAppStore } from "../../state/store";
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
      // 90 on a slider that reads as transparency is 96% opaque on a range of 86–100.
      fireEvent.change(screen.getByRole("slider", { name: "Pane transparency" }), { target: { value: "90" } });
      await waitFor(() => expect(store.getState().paneAlpha).toBe(96));
      // THE one-control mutant: the pane's slider writes the sidebar's number again.
      expect(store.getState().groundAlpha).toBe(before);
      await waitFor(() => expect(api.calls).toContain(`setSetting:${SETTING_PANE_ALPHA}=96`));
      fireEvent.click(screen.getByRole("switch", { name: "Sidebar translucency" }));
      await waitFor(() => expect(store.getState().groundAlpha).toBe(100));
      expect(store.getState().paneAlpha).toBe(96);
    } finally { vi.unstubAllGlobals(); }
  });

  it("the pane's control stops where the reading would, and its readout is the pane's own", async () => {
    vi.stubGlobal("realm", { platform: "darwin" });
    try {
      const { store } = await appearance();
      const slider = screen.getByRole("slider", { name: "Pane transparency" }) as HTMLInputElement;
      expect([slider.min, slider.max]).toEqual([String(PANE_ALPHA_RANGE.min), String(PANE_ALPHA_RANGE.max)]);
      // At the default the pane is 14% see-through — a number about the pane, not the sidebar's 45.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { useRef, type CSSProperties } from "react";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { SessionPane } from "../panes/session/SessionPane";
import { SettingsPage } from "../panes/settings/SettingsPage";
import { QuickChat } from "../components/QuickChat";
import { useAnchoredPopover } from "../components/use-anchored-popover";
import { PrompterGlass } from "./PrompterGlass";
import { GLASS_CONTROLS, GlassRoot } from "./GlassDefs";
import { reduceAll } from "../panes/session/transcript-model";
import { LOOK_SETTING, PLAIN_REASON_TEXT, plainReason, shownLook, type GlassConditions } from "./look";

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const stylesCss = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");
const cssRules = [...stylesCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel!.trim(), body: body! }));
/** Every rule body whose selector list names the glass, so a test reads what the stylesheet does. */
const glassRules = [...stylesCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => /data-look="glass"|composer-glass/.test(sel!))
  .map(([, sel, body]) => ({ sel: sel!.trim(), body: body! }));

const ALL_CLEAR: GlassConditions = { reduceTransparency: false, lowPowerMode: false, supportsBackdropUrl: true };

/** A Chromium that takes `backdrop-filter: url()`, which jsdom is not. */
const chromium = (supports = true) => vi.stubGlobal("CSS", { supports: (prop: string, value: string) => supports && prop === "backdrop-filter" && value.startsWith("url(") });
/** The Mac's Reduce Transparency, as the window reports it. */
const reduceTransparency = () => vi.stubGlobal("matchMedia", (q: string) => ({
  matches: q === "(prefers-reduced-transparency: reduce)", media: q, addEventListener() {}, removeEventListener() {},
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-low-power-mode");
  document.documentElement.removeAttribute("data-glass");
});

async function mountSession(settings: Record<string, unknown> = {}) {
  const it0 = item("i9", "s1", { kind: "session", refId: "se1", title: "s" });
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "fake" })], items: { s1: [it0] }, settings });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={it0} visible /></StoreContext.Provider>);
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { store, ...r };
}

const card = () => document.querySelector(".composer") as HTMLElement;
const glassLayer = () => document.querySelector(".composer-glass");

describe("the look", () => {
  it("is plain by default: the setting, the card and the Appearance row all say so", async () => {
    chromium();
    const { store } = await mountSession();
    expect(store.getState().look).toBe("plain");
    expect(glassLayer()).toBeNull();
    expect(card().hasAttribute("data-look")).toBe(false);
    cleanup();

    const settings = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });
    const api = fakeApi({});
    const st = createAppStore(api);
    await st.getState().boot();
    render(<StoreContext.Provider value={st}><SettingsPage item={settings} visible /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("radio", { name: "Appearance" }));
    const row = within(screen.getByRole("group", { name: "Controls" }));
    expect(row.getByRole("radio", { name: "Plain" })).toBeChecked();
    fireEvent.click(row.getByRole("radio", { name: "Glass" }));
    await waitFor(() => expect(st.getState().look).toBe("glass"));
    expect(api.calls).toContain(`setSetting:${LOOK_SETTING}=glass`);
  });

  it("never wears glass on a compact prompter, such as quick chat", async () => {
    chromium();
    const api = fakeApi({ settings: { [LOOK_SETTING]: "glass" } });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><QuickChat /></StoreContext.Provider>);
    await act(async () => { await store.getState().openQuickChat(); });
    const dialog = await screen.findByRole("dialog", { name: "Quick chat" });
    const prompter = dialog.querySelector(".composer");
    expect(prompter).not.toBeNull();
    expect(prompter!.hasAttribute("data-look")).toBe(false);
    expect(dialog.querySelector(".composer-glass")).toBeNull();
  });

  it("reads a stored value it does not know as plain", async () => {
    const { store } = await mountSession({ [LOOK_SETTING]: "frosted" });
    expect(store.getState().look).toBe("plain");
  });

  it("wears glass once chosen, where nothing holds it back", async () => {
    chromium();
    await mountSession({ [LOOK_SETTING]: "glass" });
    expect(card().getAttribute("data-look")).toBe("glass");
    expect(glassLayer()?.parentElement).toBe(card());
    expect(glassLayer()?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("glass falls back to plain", () => {
  it("under each condition alone, and only under them", () => {
    expect(shownLook("glass", ALL_CLEAR)).toBe("glass");
    expect(shownLook("plain", ALL_CLEAR)).toBe("plain");
    for (const key of ["reduceTransparency", "lowPowerMode"] as const) {
      expect(shownLook("glass", { ...ALL_CLEAR, [key]: true }), key).toBe("plain");
    }
    expect(shownLook("glass", { ...ALL_CLEAR, supportsBackdropUrl: false })).toBe("plain");
  });

  it("under macOS Reduce Transparency", async () => {
    chromium();
    reduceTransparency();
    await mountSession({ [LOOK_SETTING]: "glass" });
    expect(glassLayer()).toBeNull();
    expect(card().hasAttribute("data-look")).toBe(false);
  });

  it("but not under Realm's own Low power, which has already stilled the picture behind it", async () => {
    chromium();
    const { store } = await mountSession({ [LOOK_SETTING]: "glass", "ui.lowPower": true });
    expect(store.getState().lowPower).toBe(true);
    expect(glassLayer()).not.toBeNull();
    await act(async () => { await store.getState().setLowPower(false); });
    expect(glassLayer()).not.toBeNull();
    await act(async () => { await store.getState().setLowPower(true); });
    expect(glassLayer()).not.toBeNull();
  });

  it("under the Mac's Low Power Mode, as soon as the window is told", async () => {
    chromium();
    await mountSession({ [LOOK_SETTING]: "glass" });
    expect(glassLayer()).not.toBeNull();
    await act(async () => {
      document.documentElement.setAttribute("data-low-power-mode", "");
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(glassLayer()).toBeNull();
  });

  it("where backdrop-filter: url() is not supported", async () => {
    chromium(false);
    await mountSession({ [LOOK_SETTING]: "glass" });
    expect(glassLayer()).toBeNull();
  });
});

describe("Settings says why glass is held back", () => {
  async function appearance(settings: Record<string, unknown>) {
    const page = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });
    const st = createAppStore(fakeApi({ settings }));
    await st.getState().boot();
    render(<StoreContext.Provider value={st}><SettingsPage item={page} visible /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("radio", { name: "Appearance" }));
    return document.querySelector('[data-setting="look"]') as HTMLElement;
  }
  const note = (row: HTMLElement) => row.querySelector(".settings-row-detail")?.textContent ?? null;

  it("names the condition, and says nothing when nothing holds it back", async () => {
    chromium();
    expect(note(await appearance({ [LOOK_SETTING]: "glass", "ui.lowPower": true }))).toBeNull();
    cleanup();
    expect(note(await appearance({ [LOOK_SETTING]: "plain" }))).toBeNull();
    cleanup();
    expect(note(await appearance({ [LOOK_SETTING]: "plain", "ui.lowPower": true }))).toBeNull();
    cleanup();
    document.documentElement.setAttribute("data-low-power-mode", "");
    expect(note(await appearance({ [LOOK_SETTING]: "glass" }))).toBe(PLAIN_REASON_TEXT["low-power-mode"]);
    cleanup();
    document.documentElement.removeAttribute("data-low-power-mode");
    reduceTransparency();
    expect(note(await appearance({ [LOOK_SETTING]: "glass" }))).toBe(PLAIN_REASON_TEXT["reduce-transparency"]);
    cleanup();
    vi.unstubAllGlobals();
    chromium(false);
    expect(note(await appearance({ [LOOK_SETTING]: "glass" }))).toBe(PLAIN_REASON_TEXT["no-backdrop-url"]);
  });

  it("says where the Mac's own switches are, and offers no button for them", async () => {
    chromium();
    document.documentElement.setAttribute("data-low-power-mode", "");
    const row = await appearance({ [LOOK_SETTING]: "glass" });
    expect(note(row)).toBe("Off while Low Power Mode is on, in System Settings ▸ Battery");
    expect(row.querySelector(".settings-row-detail button")).toBeNull();
    cleanup();
    document.documentElement.removeAttribute("data-low-power-mode");
    reduceTransparency();
    expect(note(await appearance({ [LOOK_SETTING]: "glass" }))).toBe("Off while Reduce Transparency is on, in System Settings ▸ Accessibility ▸ Display");
  });

  it("puts the line under the row's name, as every row's line is", async () => {
    chromium();
    document.documentElement.setAttribute("data-low-power-mode", "");
    const row = await appearance({ [LOOK_SETTING]: "glass" });
    // A third child of the row squeezed the name under the segments.
    expect(row.querySelector(".settings-row-main > .settings-row-detail")).not.toBeNull();
  });

  it("in the order a person can act on: Reduce Transparency, the Mac's Low Power Mode, then the renderer", () => {
    const all: GlassConditions = { reduceTransparency: true, lowPowerMode: true, supportsBackdropUrl: false };
    expect(plainReason("glass", all)).toBe("reduce-transparency");
    expect(plainReason("glass", { ...all, reduceTransparency: false })).toBe("low-power-mode");
    expect(plainReason("glass", { ...all, reduceTransparency: false, lowPowerMode: false })).toBe("no-backdrop-url");
    expect(plainReason("glass", ALL_CLEAR)).toBeNull();
    expect(plainReason("plain", all)).toBeNull();
  });
});

describe("the tint under the glass", () => {
  it("is the card's own face, which the glass rules never thin or remove", () => {
    expect(glassRules.length).toBeGreaterThan(0);
    for (const { sel, body } of glassRules) {
      // The rim's ring is drawn over the face, not in place of it.
      if (sel.endsWith(")::before")) continue;
      // THE mutants: glass clearing the face's fill, or hiding the face it bends.
      expect(body, sel).not.toMatch(/--sq-fill|background|--prompter-alpha|opacity/);
      if (sel.includes("::after")) expect(body, sel).not.toMatch(/display:\s*none/);
    }
  });

  it("is in the backdrop the glass bends: the layer stacks over the face and under the content", () => {
    const z = (sel: RegExp) => Number(/z-index:\s*(-?\d+)/.exec(glassRules.find((r) => sel.test(r.sel))!.body)![1]);
    const face = z(/data-look="glass"\]::after/);
    const layer = z(/^\.composer-glass$/);
    expect(layer).toBeGreaterThan(face);
    expect(layer).toBeLessThan(0);
  });

  it("casts no lift under glass", () => {
    expect(glassRules.find((r) => /data-look="glass"\]::before/.test(r.sel))?.body).toMatch(/display:\s*none/);
    expect(glassRules.find((r) => r.sel === '.composer[data-look="glass"]')?.body).toMatch(/--shadow-card:\s*none/);
  });
});

describe("what you type into stays as it was", () => {
  /** The prompter's dock with the glass taken out, to compare with the plain one node for node. */
  const dock = () => {
    const copy = (document.querySelector(".composer-dock") ?? card().parentElement!).cloneNode(true) as HTMLElement;
    copy.querySelector(".composer-glass")?.remove();
    copy.querySelector(".composer")?.removeAttribute("data-look");
    return copy.outerHTML;
  };

  it("keeps the editor, the caret's mirror, the tabs and the bar identical between plain and glass", async () => {
    chromium();
    await mountSession();
    const plain = dock();
    const editor = document.querySelector(".composer-editor")!.outerHTML;
    expect(document.querySelector("[data-caret-mirror]")).not.toBeNull();
    cleanup();

    await mountSession({ [LOOK_SETTING]: "glass" });
    expect(glassLayer()).not.toBeNull();
    expect(document.querySelector(".composer-editor")!.outerHTML).toBe(editor);
    expect(dock()).toBe(plain);
    // The layer is empty of anything focusable, and the textarea is still the card's own.
    expect(glassLayer()!.querySelector("textarea, [tabindex], button, input")).toBeNull();
    expect(screen.getByRole("textbox", { name: /message/i }).closest(".composer")).toBe(card());
  });
});

describe("the prompter's lens", () => {
  it("is fitted to the card with the prompter's own bezel, bend and frost", () => {
    const rule = cssRules.find((r) => r.sel === ":root[data-glass] .composer-glass")!;
    expect(rule.body).toMatch(/--glass-bezel:\s*var\(--glass-prompter-bezel\)/);
    expect(rule.body).toMatch(/--glass-bend:\s*var\(--glass-prompter-bend\)/);
    expect(rule.body).toMatch(/--glass-frost-px:\s*var\(--glass-blur\)/);
    expect(rule.body).toMatch(/backdrop-filter:\s*var\(--glass-lens, blur\(var\(--glass-blur\)\)\)/);
    const src = readFileSync(join(__dirname, "PrompterGlass.tsx"), "utf8");
    expect(src).toMatch(/useFittedLens\(ref, true\)/);
  });
  it("floods the pane's ground under a picture in dark, so a see-through picture cannot show back through the dim", () => {
    // THE mutant: no flood, where the guard draws a bright picture see-through and the white sky came
    // back through the prompter's dim (placeholder 2.14:1). Never in light or Clear, which stay as they were.
    const flood = cssRules.filter((r) => /\.composer-glass$/.test(r.sel) && /--glass-ground-share/.test(r.body));
    expect(flood.map((r) => r.sel)).toEqual([':root[data-glass]:not([data-mode="light"]):not([data-clear-over-picture]) .session-pane:has(> .hero-backdrop) .composer-glass']);
    expect(flood[0]!.body).toMatch(/--glass-ground-share:\s*1/);
  });
  it("frosts nothing when the picture is to be seen clear", () => {
    expect(cssRules.some((r) => r.sel === ":root[data-glass][data-clear-over-picture] .composer-glass" && /--glass-frost-px:\s*0px/.test(r.body))).toBe(true);
  });
});

describe("one look for the whole app", () => {
  async function mountRoot(settings: Record<string, unknown> = {}) {
    const api = fakeApi({ settings });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><GlassRoot /></StoreContext.Provider>);
    return store;
  }
  const root = () => document.documentElement;

  it("is one attribute on the root, there only while glass is chosen and drawable", async () => {
    chromium();
    const store = await mountRoot();
    expect(root().hasAttribute("data-glass")).toBe(false);
    await act(async () => { await store.getState().setLook("glass"); });
    expect(root().hasAttribute("data-glass")).toBe(true);
    await act(async () => { await store.getState().setLowPower(true); });
    expect(root().hasAttribute("data-glass")).toBe(true);
    await act(async () => {
      root().setAttribute("data-low-power-mode", "");
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(root().hasAttribute("data-glass")).toBe(false);
    await act(async () => {
      root().removeAttribute("data-low-power-mode");
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(root().hasAttribute("data-glass")).toBe(true);
    await act(async () => { await store.getState().setLook("plain"); });
    expect(root().hasAttribute("data-glass")).toBe(false);
  });

  it("is plain under Reduce Transparency and where url() is not drawn", async () => {
    chromium();
    reduceTransparency();
    await mountRoot({ [LOOK_SETTING]: "glass" });
    expect(root().hasAttribute("data-glass")).toBe(false);
    cleanup();
    vi.unstubAllGlobals();
    chromium(false);
    await mountRoot({ [LOOK_SETTING]: "glass" });
    expect(root().hasAttribute("data-glass")).toBe(false);
  });

  it("fits a lens to each pressed control while glass is on, and takes them all away with it", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,map");
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(22);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const seg = document.createElement("label");
    seg.className = "seg-opt"; seg.setAttribute("data-selected", "");
    seg.style.setProperty("--glass-bezel", "6px"); seg.style.setProperty("--glass-bend", "4px");
    document.body.append(seg);
    chromium();
    const store = await mountRoot({ [LOOK_SETTING]: "glass" });
    expect(seg.style.getPropertyValue("--glass-lens")).toMatch(/^url\(#rl-lens-60x22/);
    await act(async () => { await store.getState().setLook("plain"); });
    expect(seg.style.getPropertyValue("--glass-lens")).toBe("");
    expect(document.querySelectorAll(".glass-defs filter")).toHaveLength(0);
    seg.remove();
    vi.restoreAllMocks();
  });

  it("names no lens by id in the stylesheet: every one is fitted and named on its surface", () => {
    expect(stylesCss).not.toMatch(/url\(#rl-/);
    const fittedRules = cssRules.filter((r) => r.sel.startsWith(":root[data-glass] ") && /backdrop-filter:/.test(r.body) && !/composer-(goal|todos|overstrip|understrip)/.test(r.sel));
    for (const r of fittedRules) expect(r.body, r.sel).toMatch(/backdrop-filter:\s*var\(--glass-lens, /);
  });

  it("fits the segments and the switch's knob, the knob on its own box", () => {
    expect(GLASS_CONTROLS.find((c) => c.selector === ".switch")?.pseudo).toBe("::after");
    for (const seg of ['.documents-modes button[aria-pressed="true"]', ".seg-opt[data-selected]", '.mp-seg-opt[aria-pressed="true"]'])
      expect(GLASS_CONTROLS.some((c) => c.selector.includes(seg)), seg).toBe(true);
  });
});

describe("what goes on glass, and what stays plain", () => {
  const onGlass = (sel: RegExp) => cssRules.some((r) => r.sel.startsWith(":root[data-glass] ") && sel.test(r.sel) && /backdrop-filter:/.test(r.body));
  it("the floating controls and the pressed ones", () => {
    for (const surface of [/\.composer-glass/, /\.model-picker/, /\.mention-picker/, /\.skill-picker/, /\.selection-bar/,
      /\.documents-modes button\[aria-pressed="true"\]/, /\.seg-opt\[data-selected\]/, /\.settings-tabs > \.settings-tab\[data-selected\]/, /\.switch::after/]) {
      expect(onGlass(surface), String(surface)).toBe(true);
    }
  });
  it("never a reading surface: settings pages, sheets, the transcript, the sidebar, the palette, toasts", () => {
    const glassSelectors = cssRules.filter((r) => r.sel.includes(":root[data-glass]")).map((r) => r.sel).join("\n");
    for (const reading of ["settings-page", ".sheet", ".transcript", ".msg-", ".sidebar", ".palette", ".toast", ".page-rail"]) {
      expect(glassSelectors, reading).not.toContain(reading);
    }
  });
});

describe("a picker's glass", () => {
  const pickerRules = () => cssRules.filter((r) => r.sel.startsWith(":root[data-glass] :is(.model-picker") && !r.sel.endsWith("::before"));
  it("wears its fitted lens, with a CSS frost only until the lens exists", () => {
    const rules = pickerRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.body, r.sel).toMatch(/backdrop-filter:\s*var\(--glass-lens, var\(--glass-panel-frost\)\)/);
    expect(stylesCss).not.toMatch(/url\(#rl-glass-panel\)/);
  });
  it("lays no surface of its own on the frost, over a picture or off one", () => {
    for (const r of pickerRules()) expect(r.body, r.sel).not.toMatch(/background:\s*(?!none)[^;]*var\(--surface/);
    expect(pickerRules()[0]!.body).toMatch(/background:\s*none/);
  });
});

describe("inside a glass picker", () => {
  const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
  const inside = () => cssRules.filter((r) => r.sel.startsWith(":root[data-glass] .model-picker "));
  const overlay = (name: string) => tokensCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{8})`))![1]!;
  /** A token's value in each face, read off the Glass blocks. */
  const faces = (name: string) => [...tokensCss.matchAll(new RegExp(`--${name}:\\s*var\\(--([\\w-]+)\\)`, "g"))].map((m) => m[1]!);

  it("lays its wells and its lit row on tints of the ink, never the opaque hover steps", () => {
    const wells = inside().find((r) => /\.mp-track/.test(r.sel) && /\.mp-account-well/.test(r.sel))!;
    expect(wells.sel).toMatch(/\.mp-seg\b/);
    expect(wells.sel).toMatch(/\.account-signin/);
    expect(wells.body).toMatch(/background:\s*var\(--glass-well\)/);
    const lit = inside().find((r) => /\.mp-row\[data-active\]/.test(r.sel) && /\.mp-account-row:hover/.test(r.sel))!;
    expect(lit.body).toMatch(/background:\s*var\(--glass-row\)/);
    for (const r of inside()) expect(r.body, r.sel).not.toMatch(/background:[^;]*var\(--(hover|hover-2|surface|inset)\)/);
    // Both faces, and every one a see-through share of white or black: the frost shows through.
    for (const name of ["glass-well", "glass-row"]) {
      const shares = faces(name);
      expect(shares, name).toHaveLength(2);
      for (const t of shares) expect(parseInt(overlay(t).slice(7), 16), `${name}: ${t}`).toBeLessThan(0x40);
    }
  });

  it("lights the row the pointer or the arrows are on with the rim's specular light", () => {
    const rim = inside().find((r) => r.sel.endsWith(".mp-row[data-active]::before"))!;
    expect(rim.body).toMatch(/background:\s*var\(--glass-specular\)/);
    expect(rim.body).toMatch(/mask:[^;]*content-box exclude/);
  });

  it("grows the opened account well out of its row on the popovers' own entrance, in Plain too", () => {
    const popover = cssRules.find((r) => r.sel === ".model-picker, .icon-picker" && /animation:/.test(r.body))!;
    const well = cssRules.find((r) => r.sel === ".model-picker .mp-account-well[data-open]")!;
    const anim = (body: string) => body.match(/animation:\s*([^;]+)/)![1]!.trim();
    expect(anim(well.body)).toBe(anim(popover.body));
    // Its foot is where the row was: the well grows upward from the bottom of the picker.
    expect(well.body).toMatch(/transform-origin:\s*50% 100%/);
  });

  it("leaves Plain as it was: the same rows on the opaque steps", () => {
    expect(cssRules.find((r) => r.sel === ".mp-row[data-active]")!.body).toMatch(/background:\s*var\(--hover\)/);
    expect(cssRules.find((r) => r.sel === ".mp-account-row:hover")!.body).toMatch(/background:\s*var\(--hover-2\)/);
    expect(cssRules.find((r) => r.sel === ".mp-track")!.body).toMatch(/background:\s*var\(--hover\)/);
    for (const r of cssRules) if (/mp-row\[data-active\]::before/.test(r.sel)) expect(r.sel, r.sel).toMatch(/^:root\[data-glass\]/);
  });
});

describe("a picker over a picture", () => {
  it("steps its quiet words toward the secondary ink, so they hold 3:1 on the picture's frost", () => {
    const rule = cssRules.find((r) => r.sel.startsWith(":root[data-glass] :is(.model-picker") && r.sel.endsWith("[data-over-picture]"))!;
    expect(rule.body).toMatch(/--rl-text-faint:\s*color-mix\(in oklab, var\(--ink-2\) 50%, var\(--ink-3\)\)/);
  });
  it("takes the whole step in dark, where the dim is worked out for the secondary ink", () => {
    // THE mutant: the dark face left on the half step, which glass-dim.ts does not solve for.
    const dark = cssRules.find((r) => r.sel === ':root[data-glass]:not([data-mode="light"]) :is(.model-picker, .mention-picker, .skill-picker)[data-over-picture]')!;
    expect(dark.body).toMatch(/--rl-text-faint:\s*var\(--ink-2\)/);
  });
  it("dims the picture by the glass's dim, never the picture's own", () => {
    // THE mutant: the picker back on `--picture-tone`, which holds dark glass at the fixed 0.4.
    const rule = cssRules.find((r) => r.sel.startsWith(":root[data-glass] :is(.model-picker") && r.sel.endsWith("[data-over-picture]"))!;
    expect(rule.body).toMatch(/var\(--glass-picture-tone\) var\(--glass-panel-tone\)/);
    for (const r of cssRules.filter((x) => x.sel.startsWith(":root[data-glass]"))) expect(r.body, r.sel).not.toMatch(/var\(--picture-tone\)/);
  });
  function Picker({ inPicture, dim }: { inPicture: boolean; dim?: string }) {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const ref = useRef<HTMLDivElement>(null);
    useAnchoredPopover({ ref, anchorRef, onClose: () => {}, placement: "up" });
    return (
      <div className="session-pane" style={dim ? ({ "--glass-dim": dim } as CSSProperties) : undefined}>
        {inPicture && <canvas className="hero-backdrop" />}
        <div className="composer"><button ref={anchorRef} type="button">Model</button></div>
        <div ref={ref} className="model-picker" />
      </div>
    );
  }
  it("says so, so its glass lays no surface on the picture", () => {
    render(<Picker inPicture />);
    expect(document.querySelector(".model-picker")!.hasAttribute("data-over-picture")).toBe(true);
    cleanup();
    render(<Picker inPicture={false} />);
    expect(document.querySelector(".model-picker")!.hasAttribute("data-over-picture")).toBe(false);
  });
  it("takes the dim its pane measured off the picture, since it is portalled out of the pane", () => {
    // THE mutant: the copy dropped, which leaves the picker on the fallback over a dark picture.
    render(<Picker inPicture dim="0.125" />);
    expect((document.querySelector(".model-picker") as HTMLElement).style.getPropertyValue("--glass-dim")).toBe("0.125");
    cleanup();
    render(<Picker inPicture />);
    expect((document.querySelector(".model-picker") as HTMLElement).style.getPropertyValue("--glass-dim")).toBe("");
  });
});

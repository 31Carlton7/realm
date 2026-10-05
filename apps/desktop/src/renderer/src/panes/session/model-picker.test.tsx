import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MODEL_NOTES, canonicalModelKey, type AgentKind, type ModelInfo } from "@realm/contracts";
import { exited } from "../../components/popover-exit.test-fakes";
import { ModelPicker, type OverflowGroup } from "./ModelPicker";
import { modelRows, type FastMode, type ModelRow } from "./model-catalog";
import type { AgentProbe } from "../../state/store";

const probe = (kind: AgentProbe["kind"], models: AgentProbe["models"]): AgentProbe =>
  ({ kind, available: true, version: "1", loggedIn: true, reason: null, models });

/** Cursor's live catalog, raw ids for labels, proxying a Claude model — the one overlap that gives a
 *  row a second harness. */
const CURSOR_FABLE = "claude-fable-5-1[thinking=true,context=300k,effort=high,fast=false]";
const cursorCatalog = [{ id: "default[]", label: "Auto" }, { id: CURSOR_FABLE, label: "claude-fable-5-1" }, { id: "gpt-5.5", label: "GPT-5.5" }];

const rowsFor = (over: Partial<Parameters<typeof modelRows>[0]> = {}) =>
  modelRows({ kind: "claude", model: "claude-opus-5", canSwitchAgent: true, agentProbe: [probe("acp:cursor", cursorCatalog)], ...over });

let scrolled: string[];
beforeEach(() => {
  scrolled = [];
  // jsdom has no scrolling at all; the stub is also the record of what the highlight asked to see.
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount({ rows = rowsFor(), kind = "claude" as AgentKind, model = "claude-opus-5" as string | null, effortItems = [] as OverflowGroup["items"],
  overflow, fast, info = {} }: { rows?: ModelRow[]; kind?: AgentKind; model?: string | null; effortItems?: OverflowGroup["items"];
  overflow?: OverflowGroup[]; fast?: FastMode; info?: Record<string, ModelInfo> } = {}) {
  const picked: [AgentKind, string | null][] = [];
  const starred: string[] = [];
  render(<ModelPicker kind={kind} model={model} effort={null} rows={rows} info={info}
    onToggleFavorite={(k) => starred.push(k)} onPick={(k, m) => picked.push([k, m])} effortItems={effortItems} overflow={overflow} fast={fast} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  return { picked, starred };
}

const dialog = () => screen.queryByRole("dialog", { name: "Model picker" });
const search = () => screen.getByRole("combobox", { name: "Search models" });
const option = (name: string | RegExp) => screen.getByRole("option", { name });
const active = () => document.querySelector(".mp-row[data-active]");

const repoFile = (rel: string): string => {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (dir !== "/" && !existsSync(join(dir, "pnpm-workspace.yaml"))) dir = dirname(dir);
  return join(dir, rel);
};

describe("the current choice", () => {
  it("opens on it: ticked, highlighted, and described in the strip under the list", () => {
    mount();
    const opus = option("Claude Opus 5");
    expect(opus).toHaveAttribute("aria-selected", "true");
    expect(opus).toHaveAttribute("data-active");
    expect(opus.querySelector(".mp-check")).not.toBeNull();
    // The vendor's word is the heading's and the mark's; the row says the model.
    expect(opus.querySelector(".mp-row-name")).toHaveTextContent(/^Opus 5$/);
    expect(document.querySelector(".mp-about-note")).toHaveTextContent(MODEL_NOTES.get(canonicalModelKey("Claude Opus 5"))!);
  });

  it("ticks exactly one row", () => {
    mount();
    expect(document.querySelectorAll(".mp-check")).toHaveLength(1);
  });
});

describe("picking", () => {
  it("is one click on a row, and the popover goes", async () => {
    const { picked } = mount();
    fireEvent.click(option("Claude Sonnet 5"));
    expect(picked).toEqual([["claude", "claude-sonnet-5"]]);
    await exited();
    expect(dialog()).toBeNull();
  });

  it("is Enter on the highlighted row, after walking to it", () => {
    const { picked } = mount();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(picked).toEqual([["claude", "claude-sonnet-5"]]); // the row after Opus 5
  });

  it("walks a page at a time, and stops at the ends", () => {
    mount();
    fireEvent.keyDown(search(), { key: "PageUp" });
    expect(active()).toHaveAttribute("aria-label", "Claude Fable 5.1");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(active()).toHaveAttribute("aria-label", "Claude Fable 5.1");
    fireEvent.keyDown(search(), { key: "PageDown" });
    expect(active()?.getAttribute("aria-label")).not.toBe("Claude Fable 5.1");
  });

  it("narrows as you type, and the first match is what Enter takes", () => {
    const { picked } = mount();
    fireEvent.change(search(), { target: { value: "haiku" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["Claude Haiku 4.5"]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(picked).toEqual([["claude", "claude-haiku-4-5"]]);
  });
});

describe("the harness, only where there is a choice", () => {
  it("shows a model's other harness on its row, and one click there runs it through that one", () => {
    const { picked } = mount();
    fireEvent.mouseEnter(option("Claude Fable 5.1"));
    const ways = within(option("Claude Fable 5.1")).getByRole("group", { name: "Run Claude Fable 5.1 through" });
    const buttons = within(ways).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Run Claude Fable 5.1 through Claude", "Run Claude Fable 5.1 through Cursor"]);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true"); // where a click on the row goes
    fireEvent.click(buttons[1]!);
    // Cursor's own id for the model, never Claude's re-sent to a harness that would reject it.
    expect(picked).toEqual([["acp:cursor", CURSOR_FABLE]]);
  });

  it("draws nothing about routes on a model with one way to run, or on a row not under the pointer", () => {
    mount();
    fireEvent.mouseEnter(option("Claude Sonnet 5"));
    expect(document.querySelector(".mp-ways")).toBeNull();
  });

  it("walks the highlighted model's harnesses with ←/→, and Enter takes the lit one", () => {
    const { picked } = mount();
    fireEvent.change(search(), { target: { value: "fable 5.1" } });
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    expect(within(option("Claude Fable 5.1")).getByRole("button", { name: /through Cursor/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(picked).toEqual([["acp:cursor", CURSOR_FABLE]]);
  });

  it("leaves ←/→ to the search field's caret on a row with one harness", () => {
    mount();
    // `fireEvent` answers false when a handler called preventDefault — the caret would not move.
    expect(fireEvent.keyDown(search(), { key: "ArrowRight" })).toBe(true);
  });

  it("re-routes the model it was changed on, not the next one looked at", () => {
    mount();
    fireEvent.mouseEnter(option("Claude Fable 5.1"));
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(within(option("Claude Fable 5.1")).getByRole("button", { name: /through Cursor/ })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the long list", () => {
  it("folds the agents with nothing but a default into one group, each named by the agent", () => {
    mount({ rows: rowsFor({ agentProbe: [] }) });
    const others = screen.getByRole("group", { name: "Other agents" });
    const names = within(others).getAllByRole("option").map((o) => o.getAttribute("aria-label"));
    // Codex and Cursor say which model their default is; the rest have no name to say.
    expect(names).toEqual(expect.arrayContaining(["Codex, GPT-5.6", "Cursor, Composer", "OpenCode", "Hermes"]));
    expect(new Set(names).size).toBe(names.length);
    expect(within(others).queryAllByText("Default")).toEqual([]);
  });

  it("keeps the session's own agent leading under its own name when it lists nothing", () => {
    const rows = modelRows({ kind: "acp:openhands", model: null, canSwitchAgent: true, agentProbe: [] });
    mount({ rows, kind: "acp:openhands", model: null });
    const groups = within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("group");
    expect(groups[0]).toHaveAttribute("aria-label", "OpenHands");
    expect(within(groups[0]!).getByRole("option", { name: "Default" })).toHaveAttribute("aria-selected", "true");
  });

  it("puts a star on the row under the pointer, not a column of them down the list", () => {
    const { starred } = mount();
    expect(document.querySelectorAll(".mp-star")).toHaveLength(1); // the highlighted current row's
    fireEvent.mouseEnter(option("Claude Sonnet 5"));
    expect(document.querySelectorAll(".mp-star")).toHaveLength(1);
    fireEvent.click(within(option("Claude Sonnet 5")).getByRole("button", { name: "Favourite Claude Sonnet 5" }));
    // Starring a model is not choosing it.
    expect(starred).toEqual([canonicalModelKey("Claude Sonnet 5")]);
    expect(dialog()).toBeInTheDocument();
  });

  it("dissolves at its ends with the app's own primitive", () => {
    mount();
    expect(screen.getByRole("listbox", { name: "Models" })).toHaveAttribute("data-dissolve");
  });
});

describe("a session that has already run", () => {
  const locked = () => rowsFor({ canSwitchAgent: false });

  it("lists only what it can still run, and says why in one line", () => {
    mount({ rows: locked() });
    const groups = within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Claude"]);
    expect(document.querySelector(".mp-locked")).toHaveTextContent("This session has already run on Claude, so other agents’ models are not offered.");
    expect(document.querySelector(".mp-ways")).toBeNull();
  });

  it("explains an empty search that matched only models it can no longer reach", () => {
    mount({ rows: locked() });
    fireEvent.change(search(), { target: { value: "gpt" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(document.querySelector(".mp-empty")).toHaveTextContent(/No Claude model matches “gpt” — this session has already run/);
  });
});

describe("the strip under the list", () => {
  it("names the context and API price, with who bills for the harness a hover away", () => {
    const key = canonicalModelKey("Claude Opus 5");
    mount({ info: { [key]: { key, label: "Claude Opus 5", vendor: "Anthropic", priceIn: 5, priceOut: 25, context: 200_000, efforts: [], blurb: null } } });
    const specs = document.querySelector(".mp-about-specs")!;
    expect(specs).toHaveTextContent("200K context · $5 in · $25 out per Mtok");
    expect(specs.getAttribute("title")).toMatch(/Claude subscription/);
  });

  it("sets a harness's commands as code, and keeps the tooltip plain", () => {
    const rows = modelRows({ kind: "acp:openhands", model: null, canSwitchAgent: true, agentProbe: [] });
    mount({ rows, kind: "acp:openhands", model: null });
    const note = document.querySelector(".mp-about-note")!;
    expect([...note.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["openhands", "/settings"]);
    expect(note.textContent).not.toContain("`");
    expect(note.getAttribute("title")).not.toContain("`");
  });

  it("holds one height whatever the model says — the popover grows upward, so a taller strip would move the rows", () => {
    const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");
    const about = /\.mp-about \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(about).toMatch(/(^|[;\s])height:/);
    expect(about).not.toMatch(/min-height|max-height/);
  });
});

describe("where it opens", () => {
  it("is never taller than the roomier side of its chip, so it opens whole beside it", () => {
    /* A brand-new session's prompter sits mid-window. With 300px above the chip and 440px below,
       neither held the whole list, and the picker landed on its own chip or ran off the window. */
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("aria-label") === "Model" ? new DOMRect(900, 300, 140, 28) : real.call(this);
    });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
    mount();
    expect(dialog()!.style.maxHeight).toBe(`${768 - 328 - 10}px`);
  });
});

describe("how it runs", () => {
  const effort = (pick: (l: string) => void, checked = "high"): OverflowGroup["items"] =>
    ["low", "medium", "high"].map((l) => ({ label: l, checked: l === checked, effort: l, onSelect: () => pick(l) }));

  it("changes effort in place: the segment answers, and the popover stays to show it", async () => {
    const chosen: string[] = [];
    mount({ effortItems: effort((l) => chosen.push(l)) });
    fireEvent.click(within(screen.getByRole("group", { name: "Effort" })).getByRole("button", { name: "low" }));
    expect(chosen).toEqual(["low"]);
    // Past the exit window, not just the click: a closing popover is still in the DOM for its fade.
    await exited();
    expect(dialog()).toBeInTheDocument();
    expect(dialog()).not.toHaveAttribute("data-closing");
  });

  it("draws no effort control where the harness receives none", () => {
    mount({ effortItems: [] });
    expect(screen.queryByRole("group", { name: "Effort" })).toBeNull();
  });

  it("lets a folded chip's group close on a pick, as the chip's own menu did", async () => {
    const chosen: string[] = [];
    mount({ overflow: [{ label: "Permissions", items: [{ label: "Accept edits", onSelect: () => chosen.push("acceptEdits") }] }] });
    fireEvent.click(within(screen.getByRole("group", { name: "Permissions" })).getByRole("button", { name: "Accept edits" }));
    expect(chosen).toEqual(["acceptEdits"]);
    await exited();
    expect(dialog()).toBeNull();
  });

  it("puts fast mode on the same surface, as a switch, and keeps it open on a flip", async () => {
    const flips: boolean[] = [];
    mount({ fast: { on: false, state: null, reason: null, requested: null, onChange: (on) => flips.push(on), availability: { state: "unknown" } } });
    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
    expect(flips).toEqual([true]);
    await exited();
    expect(dialog()).toBeInTheDocument();
    expect(dialog()).not.toHaveAttribute("data-closing");
  });
});

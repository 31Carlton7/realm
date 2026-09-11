import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { canonicalModelKey, type AgentKind, type ModelInfo } from "@realm/contracts";
import { ModelPicker } from "./ModelPicker";
import { modelRows } from "./model-rows";
import type { AgentProbe } from "../../state/store";

const probe = (kind: AgentProbe["kind"], models: AgentProbe["models"]): AgentProbe =>
  ({ kind, available: true, version: "1", loggedIn: true, reason: null, models });

/** Claude's curated list plus a Codex catalog. Every selectable harness earns a separator (a row can
 *  be routed through it even where it leads nowhere), so the strip under test is a dozen buttons long
 *  — which is exactly the length that made a filter strip here unreadable. */
const rows = modelRows({
  kind: "claude", model: null, canSwitchAgent: true,
  agentProbe: [probe("codex", [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }])],
});

const entry = (label: string): [string, ModelInfo] => {
  const key = canonicalModelKey(label);
  return [key, { key, label, vendor: "Anthropic", priceIn: null, priceOut: null, context: null, efforts: [], blurb: null }];
};
const info = Object.fromEntries([entry("Claude Fable 5.1"), entry("Claude Opus 5")]);

/** jsdom has no scrolling at all, so `scrollIntoView` does not exist on Element. Stubbing it is also
 *  the assertion: the strip's whole job is to call it on the right heading. */
let scrolled: { id: string; opts: unknown }[];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) { scrolled.push({ id: this.id, opts }); };
});
afterEach(() => { vi.restoreAllMocks(); });

function mount(catalog: Record<string, ModelInfo> = info) {
  const picked: [AgentKind, string | null][] = [];
  const r = render(
    <ModelPicker kind="claude" model={null} effort={null} rows={rows} info={catalog}
      onToggleFavorite={() => {}} onPick={(k, m) => picked.push([k, m])} effortItems={[]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  return { picked, ...r };
}

const bar = () => screen.getByRole("toolbar", { name: "Jump to harness" });
const jumps = () => within(bar()).getAllByRole("button").map((b) => b.textContent);
const jump = (name: string) => within(bar()).getByRole("button", { name: `Jump to ${name}` });
const listed = () => within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((o) => o.textContent ?? "");
const search = () => screen.getByRole("combobox", { name: "Search models" });
/** Only the group headings — never a scroll the highlight asked for. */
const groupScrolls = () => scrolled.filter((s) => s.id.startsWith("mp-group-")).map((s) => s.id);

const repoFile = (rel: string): string => {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (dir !== "/" && !existsSync(join(dir, "pnpm-workspace.yaml"))) dir = dirname(dir);
  return join(dir, rel);
};

describe("the jump strip names the list's own separators", () => {
  it("offers one button per harness heading, in the order the list draws them", () => {
    mount();
    // The session's own harness leads, then the ones its rows can be routed through — the same
    // sequence `groupRows` draws the headings in, which is the whole point of the strip.
    const headings = within(screen.getByRole("listbox", { name: "Models" }))
      .getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(jumps()).toEqual(headings);
    expect(jumps().slice(0, 2)).toEqual(["Claude", "Codex"]);
  });

  it("wears each harness's own mark, the one the heading and its rows already carry", () => {
    mount();
    // THE mutant: drop the icon and leave the words. The strip becomes the one run of harness names
    // in the picker with nothing to recognise at a glance, which is what it was before.
    expect(jump("Claude").querySelector("[data-brand='claude']")).not.toBeNull();
    expect(jump("Codex").querySelector("[data-brand='openai']")).not.toBeNull();
    expect(jump("Cursor").querySelector("[data-brand='cursor']")).not.toBeNull();
  });

  it("dissolves at both ends with the app's own fade, turned on its side", () => {
    mount();
    const bands = [...bar().parentElement!.querySelectorAll(".edge-fade")].map((b) => b.getAttribute("data-edge"));
    // Gated bands, not bare spans: `.edge-fade` is opacity-0 until `data-on` says there is something
    // under it, so a hand-written pair (as the model list carried) paints nothing at all, ever.
    expect(bands).toEqual(["start", "end"]);
  });

  it("dissolves the model blurb at both ends too, inside its own box", () => {
    mount();
    /* The detail column hard-clipped at both edges: a blurb taller than the box was cut mid-line
       under the harness strip and cut again against the Effort divider, which reads as a rendering
       fault rather than as more text.

       The band has to hang off `.mp-detail-wrap` and NOT off `.mp-detail`. `.mp-detail` also holds
       the Effort strip and Use model, so a band pinned to its bottom would dissolve those controls
       instead of the text above them — the mutant that still looks plausible in a diff. */
    const wrap = document.querySelector(".mp-detail-wrap");
    expect(wrap, "the blurb needs its own relative box for the bands to sit in").not.toBeNull();
    const bands = [...wrap!.querySelectorAll(":scope > .edge-fade")].map((b) => b.getAttribute("data-edge"));
    expect(bands).toEqual(["top", null]);
    // And the scroller is its sibling, not its parent: a band inside the box it fades travels with
    // the content and dissolves the middle of the blurb.
    expect(wrap!.querySelector(":scope > .mp-detail-body")).not.toBeNull();
    expect(document.querySelector(".mp-detail-body .edge-fade")).toBeNull();
  });

  it("states the band's depth once, on the row that owns both columns", () => {
    // The list and the blurb sit side by side under one border. Two dissolve depths on one surface
    // read as two materials, and the way that happens is each column declaring its own.
    const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");
    const body = /\.mp-body \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/--fade-h:/);
    expect(body).toMatch(/--fade-ground:/);
    const listWrap = /\.mp-list-wrap \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(listWrap, "the column must inherit the depth, not restate it").not.toMatch(/--fade-h:/);
  });

  it("scrolls the named heading to the top of the list", () => {
    mount();
    fireEvent.click(jump("Codex"));
    expect(groupScrolls()).toEqual(["mp-group-Codex"]);
    expect(scrolled.at(-1)!.opts).toMatchObject({ block: "start" });
  });

  it("moves nothing out of the list — a jump is navigation, not a filter", () => {
    // THE mutant this kills: reinstate the old behaviour and have a press narrow `groups`. The
    // Codex rows would vanish the moment you asked to be taken to them.
    mount();
    const before = listed();
    fireEvent.click(jump("Claude"));
    expect(listed()).toEqual(before);
    expect(listed().join(" ")).toContain("GPT-5.6-Sol");
  });

  it("carries no lit state, because a door is not a mode", () => {
    mount();
    fireEvent.click(jump("Codex"));
    for (const b of within(bar()).getAllByRole("button")) {
      expect(b.getAttribute("aria-pressed")).toBeNull();
      expect(b.getAttribute("aria-checked")).toBeNull();
    }
  });

  it("goes away while searching: a search flattens the list, leaving no separator to point at", () => {
    mount();
    fireEvent.change(search(), { target: { value: "claude" } });
    expect(screen.queryByRole("toolbar", { name: "Jump to harness" })).toBeNull();
    expect(listed().length).toBeGreaterThan(0); // …and the picker still works
  });

  it("still picks a model after a jump", () => {
    const { picked } = mount();
    fireEvent.click(jump("Codex"));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Models" })).getByText("GPT-5.6-Sol"));
    expect(picked).toEqual([["codex", "gpt-5.6-sol"]]);
  });
});

describe("the strip's arrows and the search field's arrows are different keys", () => {
  it("←/→ in the SEARCH field never move the strip — that pair walks the highlighted model's routes", () => {
    // The named mutant: bind the strip's ←/→ at the popover level instead of on the strip. The
    // route-walk and the jump then fire on the same keystroke, and a keyboard user re-routing a
    // model is yanked down the list underneath it.
    mount();
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    expect(groupScrolls()).toEqual([]);
  });

  it("←/→ inside the strip walk the separators, and wrap", () => {
    mount();
    fireEvent.keyDown(bar(), { key: "ArrowRight" });
    fireEvent.keyDown(bar(), { key: "ArrowRight" });
    fireEvent.keyDown(bar(), { key: "ArrowLeft" });
    const [first, second] = jumps();
    expect(groupScrolls()).toEqual([`mp-group-${second}`, `mp-group-${jumps()[2]}`, `mp-group-${second}`]);
    // …and Left from the first wraps to the last rather than dead-ending.
    fireEvent.keyDown(bar(), { key: "ArrowLeft" });
    expect(groupScrolls().at(-1)).toBe(`mp-group-${first}`);
    fireEvent.keyDown(bar(), { key: "ArrowLeft" });
    expect(groupScrolls().at(-1)).toBe(`mp-group-${jumps().at(-1)}`);
  });

  it("the strip is one tab stop: only the button last moved to is reachable by Tab", () => {
    mount();
    const tabbable = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("tabindex") === "0");
    expect(tabbable().map((b) => b.textContent)).toEqual(["Claude"]);
    fireEvent.click(jump("Codex"));
    expect(tabbable().map((b) => b.textContent)).toEqual(["Codex"]);
  });
});

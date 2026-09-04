import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { canonicalModelKey, type AgentKind, type ModelInfo } from "@realm/contracts";
import { ModelPicker } from "./ModelPicker";
import { filterVendor, modelRows, modelVendor, vendorsOf } from "./model-rows";
import type { AgentProbe } from "../../state/store";

const probe = (kind: AgentProbe["kind"], models: AgentProbe["models"]): AgentProbe =>
  ({ kind, available: true, version: "1", loggedIn: true, reason: null, models });

/** Claude's curated list plus a Codex catalog, so the rows carry two makers rather than one. */
const rows = modelRows({
  kind: "claude", model: null, canSwitchAgent: true,
  agentProbe: [probe("codex", [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }])],
});

const entry = (label: string, vendor: string): [string, ModelInfo] => {
  const key = canonicalModelKey(label);
  return [key, { key, label, vendor, priceIn: null, priceOut: null, context: null, efforts: [], blurb: null }];
};
/** A partial catalog on purpose: the rows it says nothing about are the Default rows and anything
 *  else no public catalog carries, which is the normal state rather than a broken one. */
const info = Object.fromEntries([
  entry("Claude Fable 5.1", "Anthropic"),
  entry("Claude Opus 5", "Anthropic"),
  entry("GPT-5.6-Sol", "OpenAI"),
]);

function mount(catalog: Record<string, ModelInfo> = info) {
  const picked: [AgentKind, string | null][] = [];
  const r = render(
    <ModelPicker kind="claude" model={null} effort={null} rows={rows} info={catalog}
      onToggleFavorite={() => {}} onPick={(k, m) => picked.push([k, m])} effortItems={[]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  return { picked, ...r };
}

const stripChips = () => within(screen.getByRole("radiogroup", { name: "Provider" }))
  .getAllByRole("radio").map((b) => b.textContent);
const chip = (name: string) => within(screen.getByRole("radiogroup", { name: "Provider" })).getByRole("radio", { name });
const lit = () => within(screen.getByRole("radiogroup", { name: "Provider" }))
  .getAllByRole("radio").find((b) => b.getAttribute("aria-checked") === "true")?.textContent;
const listed = () => within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((o) => o.textContent ?? "");
const search = () => screen.getByRole("combobox", { name: "Search models" });

describe("provider is the model's vendor, not the harness that runs it", () => {
  it("reads the maker off the catalog, and says nothing for rows no catalog covers", () => {
    const fable = rows.find((r) => r.label === "Claude Fable 5.1")!;
    expect(modelVendor(fable, info)).toBe("Anthropic");
    // Every harness's Default row is in no catalog at all — that is ordinary, and it is why there is
    // no "Other" chip collecting them.
    const fallback = rows.find((r) => r.key.startsWith("default:"))!;
    expect(modelVendor(fallback, info)).toBeNull();
  });

  it("lists each vendor once, in the order the rows introduce them", () => {
    expect(vendorsOf(rows, info)).toEqual(["Anthropic", "OpenAI"]);
    expect(vendorsOf(rows, {})).toEqual([]); // no catalog, no axis to filter on
  });

  it("narrows to one maker across every harness that offers it", () => {
    const anthropic = filterVendor(rows, "Anthropic", info);
    expect(anthropic.map((r) => r.label)).toEqual(["Claude Fable 5.1", "Claude Opus 5"]);
    expect(filterVendor(rows, null, info)).toBe(rows);
  });
});

describe("the provider strip", () => {
  it("leads with the way back and offers every vendor the rows carry", () => {
    mount();
    expect(stripChips()).toEqual(["All", "Anthropic", "OpenAI"]);
    expect(lit()).toBe("All");
  });

  it("is absent when no catalog arrived — an axis with one value is not a control", () => {
    mount({});
    expect(screen.queryByRole("radiogroup", { name: "Provider" })).toBeNull();
    expect(listed().length).toBeGreaterThan(0); // …and the picker still works
  });

  it("narrows the list, and the lit chip says which narrowing is in force", () => {
    mount();
    const before = listed();
    fireEvent.click(chip("Anthropic"));
    expect(lit()).toBe("Anthropic");
    expect(listed().join(" ")).toContain("Claude Fable 5.1");
    expect(listed().join(" ")).not.toContain("GPT-5.6-Sol");
    fireEvent.click(chip("All"));
    expect(listed()).toEqual(before);
  });

  it("composes with the text query instead of replacing it", () => {
    mount();
    fireEvent.click(chip("Anthropic"));
    fireEvent.change(search(), { target: { value: "opus" } });
    // The named mutant: have the chip REPLACE the query (or the query clear the chip) and one of
    // these two lines goes — either GPT rows come back, or every Claude model does.
    expect(listed().join(" ")).toContain("Claude Opus 5");
    expect(listed().join(" ")).not.toContain("Claude Fable 5.1");
    expect(listed().join(" ")).not.toContain("GPT");
  });

  it("a provider the query has emptied is dimmed, still reachable, and says how to get back", () => {
    mount();
    fireEvent.change(search(), { target: { value: "gpt" } });
    expect(chip("Anthropic")).toHaveAttribute("data-empty");
    expect(chip("OpenAI")).not.toHaveAttribute("data-empty");
    fireEvent.click(chip("Anthropic"));
    expect(screen.getByRole("listbox", { name: "Models" })).toHaveTextContent(/No Anthropic models match/);
    fireEvent.click(screen.getByRole("button", { name: "Show every provider" }));
    expect(lit()).toBe("All");
    expect(listed().join(" ")).toContain("GPT");
  });

  it("still picks a model after a provider has narrowed the list", () => {
    const { picked } = mount();
    fireEvent.click(chip("OpenAI"));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Models" })).getByText("GPT-5.6-Sol"));
    expect(picked).toEqual([["codex", "gpt-5.6-sol"]]);
  });
});

describe("the strip's arrows and the search field's arrows are different keys", () => {
  it("←/→ in the SEARCH field never move the provider — that pair walks the highlighted model's routes", () => {
    // The named mutant: bind the strip's ←/→ at the popover level instead of on the strip. The
    // route-walk and the provider filter then fire on the same keystroke, and a keyboard user
    // re-routing a model silently re-filters the list underneath it.
    mount();
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    expect(lit()).toBe("All");
  });

  it("←/→ inside the strip walk the providers, and wrap", () => {
    mount();
    const group = screen.getByRole("radiogroup", { name: "Provider" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(lit()).toBe("Anthropic");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(lit()).toBe("OpenAI");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(lit()).toBe("All");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(lit()).toBe("OpenAI");
  });

  it("the strip is one tab stop: only the chip in force is reachable by Tab", () => {
    mount();
    const tabbable = within(screen.getByRole("radiogroup", { name: "Provider" }))
      .getAllByRole("radio").filter((b) => b.getAttribute("tabindex") === "0");
    expect(tabbable.map((b) => b.textContent)).toEqual(["All"]);
  });
});

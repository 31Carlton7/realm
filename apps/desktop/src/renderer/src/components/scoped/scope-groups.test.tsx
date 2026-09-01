import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ItemScope } from "@realm/contracts";
import { ScopeGroups, scopeGroupOf } from "./ScopeGroups";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

/* Defaults: profiles p1 "Work" / p2 "School"; spaces s1 (p1) / s2 (p2). */
async function mount(entries: { key: string; scope: ItemScope }[]) {
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  render(
    <StoreContext.Provider value={store}>
      <ScopeGroups entries={entries.map((e) => ({ ...e, row: <li key={e.key}>{e.key}</li> }))} />
    </StoreContext.Provider>,
  );
  return store;
}

const spaceScope = (spaceId: string | null): ItemScope => ({ kind: "space", spaceId });
const profileScope = (profileId: string): ItemScope => ({ kind: "profile", profileId });

describe("ScopeGroups — the one grouped-scope renderer (Plan 12 W4)", () => {
  it("renders the contract's three labelled groups, in order: This space, From <profile>, Everywhere", async () => {
    await mount([
      { key: "legacy", scope: spaceScope(null) },
      { key: "inherited", scope: profileScope("p1") },
      { key: "mine", scope: spaceScope("s1") },
    ]);
    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["This space", "From Work", "Everywhere"]);
    expect(within(screen.getByRole("region", { name: "This space" })).getByText("mine")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "From Work" })).getByText("inherited")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Everywhere" })).getByText("legacy")).toBeInTheDocument();
  });

  it("NEVER merges two profiles into one group — one labelled section per profileId (named W4 mutant)", async () => {
    // The list RPCs only ever return one profile's rows, but the grouping must not assume it.
    await mount([
      { key: "work-item", scope: profileScope("p1") },
      { key: "school-item", scope: profileScope("p2") },
    ]);
    const work = screen.getByRole("region", { name: "From Work" });
    const school = screen.getByRole("region", { name: "From School" });
    expect(within(work).getByText("work-item")).toBeInTheDocument();
    expect(within(work).queryByText("school-item")).toBeNull();
    expect(within(school).getByText("school-item")).toBeInTheDocument();
  });

  it("an empty group renders no header — a label over nothing would claim a scope holds items", async () => {
    await mount([{ key: "mine", scope: spaceScope("s1") }]);
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Everywhere" })).toBeNull();
    expect(screen.queryByText(/^From /)).toBeNull();
  });

  it("scopeGroupOf: profile → its own group; space null → everywhere; space id → this space", () => {
    expect(scopeGroupOf(profileScope("p9"))).toBe("profile:p9");
    expect(scopeGroupOf(spaceScope(null))).toBe("everywhere");
    expect(scopeGroupOf(spaceScope("s1"))).toBe("this-space");
  });
});

/* ——— The structural half (the W2 discipline, apps/server/src/scoping.test.ts's grep, renderer-side):
   the grouping and the move-confirm copy each have exactly ONE definition, and every scoped surface
   renders THROUGH them. A second copy of either is how two surfaces start disagreeing. ——— */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // renderer/src

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "assets") out.push(...sourceFiles(p)); continue; }
    if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith("test-fakes.ts")) out.push(p);
  }
  return out;
}

function filesMentioning(needle: string): string[] {
  return sourceFiles(SRC)
    .filter((p) => readFileSync(p, "utf8").includes(needle))
    .map((p) => relative(SRC, p))
    .sort();
}

describe("the shared group-list component is kept single (W4's structural rule)", () => {
  it.each([
    ["the group component", "export function ScopeGroups", ["components/scoped/ScopeGroups.tsx"]],
    ["the grouping math", "function scopeGroupOf", ["components/scoped/ScopeGroups.tsx"]],
    ["the This-space label", 'label: "This space"', ["components/scoped/ScopeGroups.tsx"]],
    ["the Everywhere label", 'label: "Everywhere"', ["components/scoped/ScopeGroups.tsx"]],
    ["the move confirm", "export function MoveScopeConfirm", ["components/scoped/ScopeGroups.tsx"]],
    ["the promote semantics sentence", "will see it; spaces that had it stay as they are", ["components/scoped/ScopeGroups.tsx"]],
  ])("%s: exactly one definition site", (_what, needle, owners) => {
    expect(filesMentioning(needle)).toEqual(owners);
  });

  it("every scoped surface renders through ScopeGroups — the Library/Connections pages and the space-page tabs share it, not fork it", () => {
    // LibraryPage's skills tab and ConnectionsPage's body reuse SkillsPanel/McpSection, so the
    // component set below covers all four surfaces.
    expect(filesMentioning("<ScopeGroups")).toEqual([
      "components/settings/SkillsPanel.tsx",
      "components/sidebar/McpSection.tsx",
      "panes/library/LibraryPage.tsx",
    ]);
  });
});

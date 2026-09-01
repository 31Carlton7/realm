import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SkillsPanel } from "./SkillsPanel";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, skillRow, type FakeData } from "../../state/store.test-fakes";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({
    skills: {
      s1: [skillRow("mac"), skillRow("broken", { valid: false, reason: "SKILL.md has no description frontmatter" })],
      s2: [skillRow("mac")],
    },
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SkillsPanel spaceId="s1" /></StoreContext.Provider>);
  await screen.findByText("mac");
  return { api, store };
}

describe("the skills panel", () => {
  it("lists every skill; an invalid one is SHOWN with its reason, never hidden", async () => {
    // The named mutant: drop invalid rows and a typo in frontmatter makes a skill silently vanish —
    // the exact failure mode W1 designed against.
    await mount();
    const broken = screen.getByText("broken").closest(".settings-row") as HTMLElement;
    expect(within(broken).getByText(/SKILL\.md has no description frontmatter/)).toBeInTheDocument();
    // No toggle on an invalid skill: it is never staged whatever the flag says, and a switch that
    // does nothing would claim otherwise.
    expect(within(broken).queryByRole("switch")).toBeNull();
    // The valid skill has one, on.
    expect(screen.getByRole("switch", { name: "Skill mac in this space" })).toBeChecked();
  });

  it("says, beside the toggles, that enabling a skill isolates Claude from the user's own skills", async () => {
    // Mandatory disclosure #1 (W1 carry-forward): settingSources: [] costs the user their installed
    // skills for this space's Claude sessions, and CLAUDE.md is re-injected to compensate.
    await mount();
    expect(screen.getByText(/isolates this space's Claude sessions from your own installed skills/)).toBeInTheDocument();
    expect(screen.getByText(/re-injected by Realm to compensate/)).toBeInTheDocument();
  });

  it("says, on the Codex row, that skills enabled anywhere reach Codex sessions everywhere", async () => {
    // Mandatory disclosure #2: Codex skill roots are per-connection, not per-space.
    await mount();
    expect(screen.getByText(/visible to Codex sessions in every space/)).toBeInTheDocument();
  });

  it("tells the truth about Cursor: no skills route, said out loud, not faked", async () => {
    await mount();
    expect(screen.getByText(/Cursor cannot be given a skills directory/)).toBeInTheDocument();
  });

  it("shows the library folder so the user knows where skills come from", async () => {
    await mount();
    expect(screen.getAllByText("/realm-home/skills").length).toBeGreaterThan(0);
    expect(screen.getByText(/New skills are on by default/)).toBeInTheDocument();
  });

  it("disabling writes THIS space's set — the other space keeps the skill on", async () => {
    // The named mutant: a toggle that writes global state. s2 holds the same skill id; it must not move.
    const { api } = await mount();
    fireEvent.click(screen.getByRole("switch", { name: "Skill mac in this space" }));
    await waitFor(() => expect(api.calls).toContain("setSkillEnabled:s1:mac=false"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Skill mac in this space" })).not.toBeChecked());
    expect(api.data.skills.s2!.find((s) => s.id === "mac")!.enabled).toBe(true);
  });

  it("enabling writes THIS space's set — the other space keeps the skill off", async () => {
    // The same mutant, other direction: an enable that arms every space.
    const { api } = await mount({
      skills: { s1: [skillRow("mac", { enabled: false })], s2: [skillRow("mac", { enabled: false })] },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Skill mac in this space" }));
    await waitFor(() => expect(api.calls).toContain("setSkillEnabled:s1:mac=true"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Skill mac in this space" })).toBeChecked());
    expect(api.data.skills.s2!.find((s) => s.id === "mac")!.enabled).toBe(false);
  });

  it("points at the library folder when it is empty", async () => {
    const api = fakeApi({ skills: { s1: [] } });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><SkillsPanel spaceId="s1" /></StoreContext.Provider>);
    await screen.findByText(/No skills yet/);
    expect(screen.getByText("/realm-home/skills")).toBeInTheDocument();
  });
});

/* ——— Plan 12 W4: the scoped groups over the same rows, and scope movement. ——— */

describe("scoped skill groups (W4)", () => {
  const scoped: FakeData = {
    skills: {
      s1: [
        skillRow("mine", { scope: { kind: "space", spaceId: "s1" } }),
        skillRow("shared", { scope: { kind: "profile", profileId: "p1" } }),
        // Pre-scoping rows — exactly what the bundled mac + browsing skills are on a real install.
        skillRow("mac"), skillRow("browsing"),
      ],
      s2: [],
    },
  };

  it("groups rows This space / From Work / Everywhere — the bundled skills render under Everywhere", async () => {
    await mount(scoped);
    expect(within(screen.getByRole("region", { name: "This space" })).getByText("mine")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "From Work" })).getByText("shared")).toBeInTheDocument();
    const everywhere = screen.getByRole("region", { name: "Everywhere" });
    expect(within(everywhere).getByText("mac")).toBeInTheDocument();
    expect(within(everywhere).getByText("browsing")).toBeInTheDocument();
  });

  it("an inherited row's toggle rides the per-space wire with the VANTAGE space id — never the defining scope (named mutant)", async () => {
    const { api } = await mount(scoped);
    fireEvent.click(screen.getByRole("switch", { name: "Skill shared in this space" }));
    await waitFor(() => expect(api.calls).toContain("setSkillEnabled:s1:shared=false"));
    expect(api.calls.some((c) => c.startsWith("promoteSkill") || c.startsWith("demoteSkill"))).toBe(false);
  });

  it("Move to profile: the confirm states the reach semantics; Cancel fires nothing", async () => {
    const { api } = await mount(scoped);
    const row = screen.getByText("mine").closest(".settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Move to profile…" }));
    expect(within(row).getByText("Move “mine” to Work? Other spaces in Work will see it; spaces that had it stay as they are.")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(api.calls.some((c) => c.startsWith("promoteSkill"))).toBe(false);
  });

  it("confirming Move to profile fires skills.promote with the vantage space id and the skill id — never demote (named mutant)", async () => {
    const { api } = await mount(scoped);
    const row = screen.getByText("mine").closest(".settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Move to profile…" }));
    fireEvent.click(within(row).getByRole("button", { name: "Move to profile" }));
    await waitFor(() => expect(api.calls).toContain("promoteSkill:s1:mine"));
    expect(api.calls.some((c) => c.startsWith("demoteSkill"))).toBe(false);
    // The re-read moves the row into the inherited group.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "From Work" })).getByText("mine")).toBeInTheDocument());
  });

  it("the symmetric demote from the inherited group fires skills.demote with the same ids", async () => {
    const { api } = await mount(scoped);
    const row = screen.getByText("shared").closest(".settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Move to this space…" }));
    expect(within(row).getByText("Keep “shared” in this space only? Other spaces in Work will stop seeing it; this space keeps it as it is.")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Move to this space" }));
    await waitFor(() => expect(api.calls).toContain("demoteSkill:s1:shared"));
    expect(api.calls.some((c) => c.startsWith("promoteSkill"))).toBe(false);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "This space" })).getByText("shared")).toBeInTheDocument());
  });

  it("an invalid skill keeps its reason line inside its group and gets no move affordance", async () => {
    await mount(); // default rows: mac (valid) + broken (invalid), both pre-scoping
    const everywhere = screen.getByRole("region", { name: "Everywhere" });
    const broken = within(everywhere).getByText("broken").closest(".settings-row") as HTMLElement;
    expect(within(broken).getByText(/SKILL\.md has no description frontmatter/)).toBeInTheDocument();
    expect(within(broken).queryByRole("button", { name: /Move to/ })).toBeNull();
  });
});

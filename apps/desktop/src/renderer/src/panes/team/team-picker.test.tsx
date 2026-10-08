import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, teamRole, teamSpace, type FakeData } from "../../state/store.test-fakes";
import { Sidebar } from "../../components/sidebar/Sidebar";
import { TeamPage } from "./TeamPages";
import { AddTeammatesSheet } from "./TeamPicker";

/**
 * Choosing who is on a team: the gallery, the person's own teammates, the shares of the week, the
 * memory folder when Realm's own is refused — and, once the team exists, adding to it, duplicating
 * and removing a role. Every test names the change that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = (extra: Partial<FakeData> = {}): FakeData => ({
  profiles: [profile("p1", "Work")],
  spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "QA Lab")],
  ...extra,
});

async function mount(data: FakeData, ui: ReactNode) {
  const api = fakeApi(data);
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  render(<StoreContext.Provider value={store}>{ui}</StoreContext.Provider>);
  return { api, store };
}

const card = (name: string) => screen.getByText(name, { selector: ".tp-card-name" }).closest(".tp-card") as HTMLElement;
const pick = (name: string) => fireEvent.click(within(card(name)).getByRole("checkbox"));
const makeButton = (space = "QA Lab") => screen.getByRole("button", { name: `Make ${space} a team` });

describe("making a team: who is on it", () => {
  it("offers seven starters on two shelves, picks none for you, and says what the picks share of the week", async () => {
    await mount(base(), <TeamPage spaceId="s2" tab="team" />);
    const any = screen.getByRole("region", { name: "For any team" });
    const creators = screen.getByRole("region", { name: "For work with creators" });
    // THE MUTANT: the creator roles on the first shelf, or preselected — a space that is not about creators handed them anyway.
    expect([...any.querySelectorAll("[data-template] .tp-card-name")].map((n) => n.textContent)).toEqual(["Researcher", "Editor", "Growth Analyst", "Community Manager", "Ops"]);
    expect([...creators.querySelectorAll("[data-template] .tp-card-name")].map((n) => n.textContent)).toEqual(["Creator Manager", "Content Producer"]);
    expect(screen.queryAllByRole("checkbox", { checked: true })).toHaveLength(0);
    expect(makeButton()).toBeDisabled();
    // No starter brief names one business.
    expect(document.body.textContent).not.toMatch(/Versed|TikTok/);
    pick("Researcher");
    pick("Editor");
    expect(makeButton()).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Shares come to $15 of the team's $60 a week");
  });

  it("past the week: says by how much, holds the button, and raising the week sends the raise with the team", async () => {
    const { api } = await mount(base(), <TeamPage spaceId="s2" tab="team" />);
    for (const n of ["Researcher", "Editor", "Growth Analyst", "Community Manager", "Ops", "Creator Manager", "Content Producer"]) pick(n);
    expect(screen.getByRole("status")).toHaveTextContent("Shares come to $85 of the team's $60 a week — $25 over");
    // THE MUTANT: the press allowed while over — the server refuses it and the person learns nothing new.
    expect(makeButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Raise the team's week to $85" }));
    expect(screen.getByRole("status")).toHaveTextContent("Shares come to $85 of the team's $85 a week");
    fireEvent.click(makeButton());
    await waitFor(() => expect(api.calls).toContain("teamMake:s2:researcher,editor,growth-analyst,community-manager,ops,creator-manager,content-producer$85"));
  });

  it("a custom teammate is written in the role sheet, held as a card, and made with the team", async () => {
    const { api } = await mount(base(), <TeamPage spaceId="s2" tab="team" />);
    fireEvent.click(screen.getByRole("button", { name: /Custom teammate/ }));
    const sheet = await screen.findByRole("dialog", { name: "Custom teammate" });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Podcast Booker" } });
    fireEvent.change(within(sheet).getByLabelText("What they do"), { target: { value: "Find guests and draft the pitch to each." } });
    fireEvent.change(within(sheet).getByLabelText("Mode"), { target: { value: "plan" } });
    fireEvent.change(within(sheet).getByLabelText("A week, at most ($)"), { target: { value: "8" } });
    expect(within(sheet).getByText(/Shares come to \$8 of the team's \$60 a week/)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Add to the team" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card("Podcast Booker")).toHaveTextContent("Find guests and draft the pitch to each.");
    expect(screen.getByRole("status")).toHaveTextContent("Shares come to $8");
    // THE MUTANT: the written teammate left out of the call — the card was a promise nothing kept.
    fireEvent.click(makeButton());
    await waitFor(() => expect(api.calls).toContain("teamMake:s2:+Podcast Booker"));
  });

  it("when the team's memory can go nowhere Realm would put it, says why where the button is and lets you choose a folder", async () => {
    const message = "Realm keeps memory repos in its own folder, but that folder is inside /Users/me/Projects, which one of your spaces works in. Choose a folder outside your projects to keep it in.";
    const { api } = await mount(base({ teamMakeRefusal: { code: "MEMORY_REPO_FORBIDDEN", message } }), <TeamPage spaceId="s2" tab="team" />);
    const seen = vi.fn();
    Element.prototype.scrollIntoView = seen;
    pick("Editor");
    fireEvent.click(makeButton());
    const alert = await screen.findByRole("alert");
    // Brought into view: below the fold, the refusal reads as a press that did nothing.
    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(alert).toHaveTextContent("The team's memory needs a folder of its own");
    expect(alert).toHaveTextContent(message);
    // THE MUTANT: the refusal as a toast with no way forward — the dead end the owner hit.
    fireEvent.click(within(alert).getByRole("button", { name: "Choose a folder…" }));
    await waitFor(() => expect(api.calls).toContain("teamMake:s2:editor@/tmp/picked-repo"));
  });
});

describe("adding to a team that exists", () => {
  const manager = teamRole("r1", "s1", "Creator Manager", { template: "creator-manager", weekBudgetUsd: 20 });
  const team = () => [teamSpace("s1", [manager])];

  it("lights the starters already on it, and adds the ones picked", async () => {
    const { api } = await mount(base({ teams: team() }), <AddTeammatesSheet spaceId="s1" />);
    const dialog = screen.getByRole("dialog", { name: "Add to the Versed team" });
    // THE MUTANT: a starter on the team offered again — a second Creator Manager the server would refuse by name.
    expect(within(card("Creator Manager")).queryByRole("checkbox")).toBeNull();
    expect(card("Creator Manager")).toHaveTextContent("On the team");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Shares come to $20 of the team's $60 a week");
    pick("Researcher");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Shares come to $30");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 teammate" }));
    await waitFor(() => expect(api.calls).toContain("teamMake:s1:researcher"));
  });

  it("the sidebar's Team fold ends in Add teammate, which opens the picker for that space", async () => {
    const { store } = await mount(base({ teams: team() }), <Sidebar />);
    // THE MUTANT: no way to add from the fold — the person has to find the team's page first.
    fireEvent.click(await screen.findByRole("button", { name: "Add teammate" }));
    expect(store.getState().sheet).toEqual({ kind: "add-teammates", spaceId: "s1" });
  });
});

describe("a role's page: duplicate and remove", () => {
  const editor = teamRole("r2", "s1", "Editor", { cron: "0 9 * * 1-5", scheduleEnabled: true, weekBudgetUsd: 5 });

  it("Remove asks first, names what stays, and only the confirm removes", async () => {
    const { api } = await mount(base({ teams: [teamSpace("s1", [editor])] }), <TeamPage spaceId="s1" tab="role:r2" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Editor from the team…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Editor from the team?" });
    expect(dialog).toHaveTextContent("its schedule is deleted");
    expect(dialog).toHaveTextContent("lines in Activity stay, under its name");
    // THE MUTANT: the old one-click archive — a stray click costs a role with its clock and brief.
    expect(api.calls.some((c) => c.startsWith("teamRoleArchive"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Editor" }));
    await waitFor(() => expect(api.calls).toContain("teamRoleArchive:r2"));
  });

  it("Duplicate opens a new role with this one's fields and a free name", async () => {
    await mount(base({ teams: [teamSpace("s1", [editor, teamRole("r3", "s1", "Editor 2")])] }), <TeamPage spaceId="s1" tab="role:r2" />);
    fireEvent.click(screen.getByRole("button", { name: "More for Editor" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    const sheet = await screen.findByRole("dialog", { name: "Duplicate Editor" });
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Editor 3");
    expect(within(sheet).getByLabelText("What they do")).toHaveValue("Editor's brief.");
  });

  it("a removed role's lines in the log keep its name", async () => {
    const line = { id: "a1", spaceId: "s1", ts: Date.now(), actor: "role:gone", runId: null, sessionId: null, verb: "finished", object: "Booker", detail: { summary: "Pitched three guests." } };
    await mount(base({ teams: [teamSpace("s1", [editor], [], { formerRoles: [{ id: "gone", name: "Booker", realmite: { seed: "b" } }] })], teamActivity: { s1: [line] } }),
      <TeamPage spaceId="s1" tab="activity" />);
    // THE MUTANT: removed roles left out of the lookup — the line reads "Realm finished".
    expect(await screen.findByText(/Booker finished/)).toBeInTheDocument();
  });
});

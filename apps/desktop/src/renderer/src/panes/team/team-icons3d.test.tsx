import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { RECORD_PRESETS } from "@realm/contracts";
import { StoreContext, createAppStore, type SpacePageTab } from "../../state/store";
import { fakeApi, profile, recordType, space, teamRole, teamSpace, type FakeData } from "../../state/store.test-fakes";
import { TeamPage, TeamRailList } from "./TeamPages";
import { ChatList } from "./chat/ChatList";
import { Empty } from "./review/Inbox";
import { typePicture } from "./RecordPages";

/**
 * Where the team's 3D icons stand: the Team rows of the column, Add teammate under the chats, the
 * picker's Custom teammate, the record-type presets, and two empty states. Each test names the change
 * that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const researcher = teamRole("r1", "s1", "Researcher", { template: "researcher" });
const base = (extra: Partial<FakeData> = {}): FakeData => ({
  profiles: [profile("p1", "Work")],
  spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "QA Lab")],
  teams: [teamSpace("s1", [researcher], [], { recordTypes: [recordType("s1", "creator", { count: 1 }), recordType("s1", "lead", { count: 2, sortOrder: 1 })] })],
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

const iconIn = (el: Element) => el.querySelector<HTMLElement>(".i3d");

describe("the team's column", () => {
  // Mutant killed: a row left on its 2D glyph (Policies on the shield), or a kind of record drawn as
  // another kind's picture.
  it("draws each Team row's 3D icon at the row rung", async () => {
    const data = base();
    await mount(data, <TeamRailList spaceId="s1" team={data.teams![0]!} tab="team" pick={() => undefined} />);
    const group = screen.getByRole("group", { name: "Team" });
    const rows = [...group.querySelectorAll(".page-rail-tab")].map((r) => [r.querySelector(".tp-rail-label")!.textContent, iconIn(r)?.dataset.icon, iconIn(r)?.dataset.size]);
    expect(rows).toEqual([
      ["Review", "review", "20"], ["Overview", "overview", "20"], ["Creators", "records", "20"], ["Leads", "contact", "20"],
      ["Policies", "policies", "20"], ["Vault", "vault", "20"], ["Activity", "activity", "20"],
    ]);
  });

  // Mutant killed: `selected` not passed from the row (the icon never knows it was chosen).
  it("settles the chosen row's icon once, and only that row's", async () => {
    const data = base();
    function Column() {
      const [tab, setTab] = useState<SpacePageTab>("overview");
      return <TeamRailList spaceId="s1" team={data.teams![0]!} tab={tab} pick={setTab} />;
    }
    await mount(data, <Column />);
    const row = (label: string) => screen.getByText(label, { selector: ".tp-rail-label" }).closest("label")!;
    expect(iconIn(row("Overview"))).not.toHaveAttribute("data-settle");
    fireEvent.click(within(row("Vault")).getByRole("radio"));
    expect(iconIn(row("Vault"))).toHaveAttribute("data-settle");
    expect(iconIn(row("Overview"))).not.toHaveAttribute("data-settle");
  });

  it("draws Add teammate under the chats in the Realmites' column", async () => {
    const data = base();
    await mount(data, <ChatList spaceId="s1" team={data.teams![0]!} tab="team" pick={() => undefined} />);
    const add = screen.getByRole("button", { name: "Add teammate" });
    expect(add.querySelector(".tc-add-mark > .i3d")).toHaveAttribute("data-icon", "add-teammate");
  });
});

describe("the cards", () => {
  it("draws Custom teammate's picture on its card in the picker, beside the starters' Realmites", async () => {
    await mount(base(), <TeamPage spaceId="s2" tab="team" />);
    const custom = screen.getByRole("button", { name: /Custom teammate/ });
    expect(iconIn(custom)).toHaveAttribute("data-icon", "custom-teammate");
    expect(iconIn(custom)).toHaveAttribute("data-size", "32");
    // The starters keep their Realmites: a role's character is its creature, not a picture.
    expect(document.querySelector("[data-template] .i3d")).toBeNull();
  });

  // Mutant killed: every preset drawn as the generic records box.
  it("draws each record preset as its own kind of thing", async () => {
    await mount(base(), <TeamPage spaceId="s1" tab="recordtype:new" />);
    const cards = [...document.querySelectorAll(".tp-type-card")].map((c) => [c.querySelector(".tp-card-name")!.textContent, iconIn(c)?.dataset.icon]);
    expect(Object.fromEntries(cards)).toEqual({
      Topics: "note", Sources: "link", Customers: "contact", Companies: "briefcase", Releases: "flag", Bugs: "bug", Pieces: "note", Channels: "browser",
    });
    expect(cards.length).toBe(RECORD_PRESETS.length - 2);
  });

  it("draws a kind wearing a glyph the set has no picture for as a kind of record", () => {
    expect(typePicture({ glyph: "star" })).toBe("records");
    expect(typePicture({ glyph: "not-a-glyph" })).toBe("records");
  });
});

describe("the empty states", () => {
  // Mutant killed: the empty team back on its 24px glyph.
  it("a team with nobody on it shows the empty table", async () => {
    await mount(base({ teams: [teamSpace("s1", [])] }), <TeamPage spaceId="s1" tab="team" />);
    const empty = screen.getByText("No one is on this team").closest(".tc-empty")!;
    expect(iconIn(empty)).toHaveAttribute("data-icon", "overview");
    expect(iconIn(empty)).toHaveAttribute("data-size", "64");
  });

  it("Review with nobody to send anything shows its tray; with teammates, their Realmites instead", () => {
    const { container, rerender } = render(<Empty team={teamSpace("s1", [])} />);
    expect(iconIn(container)).toHaveAttribute("data-icon", "review");
    rerender(<Empty team={teamSpace("s1", [researcher])} />);
    expect(iconIn(container)).toBeNull();
    expect(container.querySelectorAll(".rv-empty-mate")).toHaveLength(1);
  });
});

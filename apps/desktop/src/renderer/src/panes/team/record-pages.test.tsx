import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { CREATOR_PRESET, parseRecord, recordPreset, recordTemplate, type TeamRecord } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, recordType, space, teamRole, teamSpace, type FakeData } from "../../state/store.test-fakes";
import { TeamPage, TeamRailList, teamTabLabel } from "./TeamPages";
import { RecordView } from "./RecordPages";

/**
 * A team's kinds of record on its pages: one column row per kind, each kind's list, a record drawn
 * from its type's sections, and the page a kind is shaped on. Each test names the change that would
 * make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const NATHAN = `# Nathan Beyenhof
- Status: signed
- Contact: Nathan.beyenhof@gmail.com · iMessage
- Sends from: carlton@charmtechnologies.co

## Deal
- Rate: $5 per video

## Accounts
- TikTok @versed.nathan · vault: tiktok.com/nathan · device: lab-iphone-2 · consent: contract §4
- Instagram @versed.nathan · vault: instagram.com/nathan
- YouTube Shorts: waiting on Nathan

## Deadlines
- 2026-10-08 first post · done

## Content
- 2026-10-05 "The fade" 1/3 · TikTok · views 4,812

## Gossip
- likes coffee
`;
const ACME = "# Acme Corp\n- Status: contacted\n- Company: Acme\n\n## Notes\n- Big account.\n- Slow to answer.\n\n## Touches\n- 2026-10-01 first email · sent\n";

const rec = (path: string, markdown: string, kind: string): TeamRecord => ({
  path, kind, name: parseRecord(markdown)?.title ?? path, status: null, updatedAt: 0, markdown, absPath: `/repo/${path}`, lastAuthor: "Creator Manager",
});

const manager = teamRole("r1", "s1", "Creator Manager", { template: "creator-manager" });
const base = (extra: Partial<FakeData> = {}): FakeData => ({
  profiles: [profile("p1", "Work")],
  spaces: [space("s1", "p1", "Versed")],
  teams: [teamSpace("s1", [manager], [], { recordCount: 2, recordTypes: [recordType("s1", "creator", { count: 1 }), recordType("s1", "lead", { count: 1, sortOrder: 1 })] })],
  teamRecords: { s1: [rec("creators/nathan-beyenhof.md", NATHAN, "creator"), rec("leads/acme.md", ACME, "lead")] },
  ...extra,
});

async function mount(data: FakeData, ui: (store: ReturnType<typeof createAppStore>) => ReactNode) {
  const api = fakeApi(data);
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  const view = render(<StoreContext.Provider value={store}>{ui(store)}</StoreContext.Provider>);
  return { api, store, view };
}

const railLabels = () => screen.getAllByRole("radio").map((r) => r.closest("label")!.textContent);

describe("the team's column", () => {
  it("has a row for each kind of record the team keeps, with its count, where v50 had Creators alone", async () => {
    const data = base();
    await mount(data, () => <TeamRailList spaceId="s1" team={data.teams![0]!} tab="team" pick={() => undefined} />);
    // THE MUTANT: the column hardcoding "Creators", or one row for every kind's records together.
    expect(railLabels()).toEqual(["Overview", "Creators1", "Leads1", "Roles1", "Vault", "Activity"]);
  });

  it("unfolds a kind's records while one of its pages is open, and keeps the kind lit while its fields are shaped", async () => {
    const data = base();
    const { view, store } = await mount(data, () => <TeamRailList spaceId="s1" team={data.teams![0]!} tab="records:lead" pick={() => undefined} />);
    await waitFor(() => expect(railLabels()).toEqual(["Overview", "Creators1", "Leads", "Acme Corp", "Roles1", "Vault", "Activity"]));
    expect(screen.getByRole("radio", { name: "Leads" })).toBeChecked();
    view.rerender(<StoreContext.Provider value={store}><TeamRailList spaceId="s1" team={data.teams![0]!} tab="recordtype:lead" pick={() => undefined} /></StoreContext.Provider>);
    expect(screen.getByRole("radio", { name: /^Leads/ })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Acme Corp" })).toBeNull();
  });

  it("says Records, and nothing about creators, for a team that keeps no kind yet", async () => {
    const data = base({ teams: [teamSpace("s1", [manager], [], { recordTypes: [] })] });
    await mount(data, () => <TeamRailList spaceId="s1" team={data.teams![0]!} tab="team" pick={() => undefined} />);
    expect(railLabels()).toEqual(["Overview", "Records", "Roles1", "Vault", "Activity"]);
  });

  it("names each page by its kind", () => {
    const team = base().teams![0]!;
    expect(teamTabLabel("records", team)).toBe("Creators");
    expect(teamTabLabel("records:lead", team)).toBe("Leads");
    expect(teamTabLabel("record:leads/acme.md", team)).toBe("Lead");
    expect(teamTabLabel("recordtype:creator", team)).toBe("Creator");
    expect(teamTabLabel("recordtype:new", team)).toBe("New record type");
    expect(teamTabLabel("records", { ...team, recordTypes: [] })).toBe("Records");
  });
});

describe("a kind's list", () => {
  it("lists that kind's records only, and makes a new one of that kind", async () => {
    const { api } = await mount(base(), () => <TeamPage spaceId="s1" tab="records:lead" />);
    expect(await screen.findByRole("heading", { name: "Leads" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("leads/acme.md")).toBeInTheDocument());
    expect(screen.queryByText("creators/nathan-beyenhof.md")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New lead" }));
    fireEvent.change(screen.getByRole("textbox", { name: "The lead's name" }), { target: { value: "Globex" } });
    fireEvent.click(screen.getByRole("button", { name: "Make record" }));
    // THE MUTANT: the record made without its kind — on a two-kind team, the server refuses that.
    await waitFor(() => expect(api.calls).toContain("teamRecordCreate:s1:Globex:lead"));
  });
});

describe("a record, drawn from its type", () => {
  it("draws Nathan as v50 did: the head in the Deal card, accounts with consent, a deadline's state, and what the type does not name under Other", () => {
    render(<RecordView record={parseRecord(NATHAN)!} type={CREATOR_PRESET} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Deal", "Accounts", "Deadlines", "Content", "Other"]);
    expect(screen.getByText("Contact")).toBeInTheDocument();
    expect(screen.getByText("Rate")).toBeInTheDocument();
    expect(screen.getByText("Consented")).toHaveAttribute("title", "Consent: contract §4");
    expect(screen.getByText("No consent yet")).toBeInTheDocument();
    expect(screen.getByText("tiktok.com/nathan", { exact: false }).textContent).toBe("TikTok · sign-in kept as tiktok.com/nathan · lab-iphone-2");
    expect(screen.getByText("Waiting on Nathan")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    // A Content line's tail is detail, not a state chip.
    expect(screen.getByText("TikTok · views 4,812")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Gossip" })).toBeInTheDocument();
  });

  it("draws another kind by its own sections: prose for text, a dated list, and its head fields in a card when it has no properties", () => {
    render(<RecordView record={parseRecord(ACME)!} type={recordPreset("lead")!} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Details", "Notes", "Touches"]);
    expect(screen.getByText("Big account.").tagName).toBe("P");
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
  });
});

describe("shaping a kind", () => {
  it("keeps a folder that holds records fixed, and previews the file a new record starts as", async () => {
    await mount(base(), () => <TeamPage spaceId="s1" tab="recordtype:creator" />);
    expect(await screen.findByRole("textbox", { name: "Folder" })).toBeDisabled();
    expect(screen.getByText(/Fixed: 1 record use it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Preview").textContent).toBe(recordTemplate(CREATOR_PRESET, "Jane Doe"));
  });

  it("writes what changed after a pause, and the preview follows the edit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = await mount(base(), () => <TeamPage spaceId="s1" tab="recordtype:lead" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a section" }));
    expect(screen.getByLabelText("Preview").textContent).toContain("## Section 3");
    expect(screen.getByText("Edited")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1300); });
    // THE MUTANT: the whole type sent back, or nothing sent at all.
    await waitFor(() => expect(api.calls).toContain("teamRecordTypeUpdate:rt-s1-lead:sections"));
  });

  it("asks before taking away a section a check reads, and names what it switches off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = await mount(base(), () => <TeamPage spaceId="s1" tab="recordtype:creator" />);
    expect(await screen.findByText("Review reads consent: here before anything is posted for an account")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Accounts" }));
    // THE MUTANT: the click removing it at once.
    expect(screen.getByLabelText("Preview").textContent).toContain("## Accounts");
    expect(screen.getByText(/Without Accounts, Review cannot find consent:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove, and its check" }));
    expect(screen.getByLabelText("Preview").textContent).not.toContain("## Accounts");
    await act(async () => { vi.advanceTimersByTime(1300); });
    await waitFor(() => expect(api.calls).toContain("teamRecordTypeUpdate:rt-s1-creator:sections"));
    // A section with no check goes on one click.
    fireEvent.click(screen.getByRole("button", { name: "Remove Content" }));
    expect(screen.getByLabelText("Preview").textContent).not.toContain("## Content");
  });

  it("archives a kind from its page, and says its files stay", async () => {
    const { api } = await mount(base(), () => <TeamPage spaceId="s1" tab="recordtype:lead" />);
    expect(await screen.findByText("Hides it from the column. Its files stay in leads/.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive Leads" }));
    await waitFor(() => expect(api.calls).toContain("teamRecordTypeArchive:rt-s1-lead:true"));
  });
});

describe("a new kind", () => {
  it("offers the presets the team does not keep yet, and lands on the one made", async () => {
    const { api, store } = await mount(base(), () => <TeamPage spaceId="s1" tab="recordtype:new" />);
    const cards = await screen.findAllByRole("button", { name: /\// });
    const names = cards.map((c) => within(c).getByText(/s$/, { selector: ".tp-card-name" }).textContent);
    expect(names).not.toContain("Creators");
    expect(names).not.toContain("Leads");
    expect(names).toContain("Topics");
    fireEvent.click(cards.find((c) => c.textContent?.includes("Topics"))!);
    await waitFor(() => expect(api.calls).toContain("teamRecordTypeCreate:s1:topic"));
    await waitFor(() => expect(store.getState().spacePageTab.s1).toBe("recordtype:topic"));
  });

  it("is where a team with no kinds starts, from its Records row", async () => {
    await mount(base({ teams: [teamSpace("s1", [manager], [], { recordTypes: [] })] }), () => <TeamPage spaceId="s1" tab="records" />);
    expect(await screen.findByText(/This team keeps no records yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Creators/ })).toBeInTheDocument();
  });
});

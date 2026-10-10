import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TeamPolicies, TeamPolicyTool } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, teamRole, teamSpace } from "../../state/store.test-fakes";
import { PoliciesPage } from "./PoliciesPage";
import { setPoliciesClient } from "./policies-client";
import { ACT_ROWS, classRows, classToday, connectorSummary, toolLabel, toolNote } from "./policies-format";

/**
 * The team's Policies page, read-only: the four kinds of action, Realm's own tools as one connection,
 * each server's tools under it, and nothing that changes anything. The mutants are named per test.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setPoliciesClient(null); });

const S = "01J00000000000000000SPACE1";
const tool = (name: string, over: Partial<TeamPolicyTool>): TeamPolicyTool =>
  ({ tool: name, class: "read", source: "server", verb: name.split("_")[0]!, floor: null, overrideIgnored: false, asksFirst: null, asksToday: true, ...over });

const VIEW: TeamPolicies = {
  spaceId: S,
  connectors: [
    { connector: "realm:realm-docs", kind: "realm", name: "Documents", icon: null, reached: true, tools: [
      tool("docs_read", { source: "realm", asksToday: false }),
      tool("docs_list", { source: "realm", asksFirst: "it makes the space's Documents workspace the first time" }),
    ] },
    { connector: "realm:realm-vault", kind: "realm", name: "Vault", icon: null, reached: true, tools: [
      tool("vault_http", { source: "realm", class: "irreversible-external" }),
    ] },
    { connector: "mcp:STUB", kind: "server", name: "stub", icon: null, reached: true, tools: [
      tool("read_thing", {}),
      tool("save_thing", { class: "reversible-external" }),
      tool("send_thing", { class: "irreversible-external", source: "unclassified" }),
      tool("send_quietly", { class: "irreversible-external", floor: "send" }),
    ] },
    { connector: "mcp:GONE", kind: "server", name: "offline", icon: null, reached: false, tools: [] },
  ],
};

async function mount(held = false) {
  setPoliciesClient({ view: async () => VIEW });
  const api = fakeApi({ profiles: [profile("p1", "Work")], spaces: [space(S, "p1", "Versed")], teams: [{ ...teamSpace(S, [teamRole("01J0000000000000000ANALYST", S, "Growth Analyst")]), actsHeld: held }] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  render(<StoreContext.Provider value={store}><PoliciesPage spaceId={S} team={store.getState().teams[S]!} /></StoreContext.Provider>);
  await screen.findByText("By kind of action");
  return { store };
}

const rowOf = (text: string) => screen.getByText(text).closest("li")!;

describe("the Policies page", () => {
  it("reads by kind of action, then the acts, then the connections, then what else holds", async () => {
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Policies");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["By kind of action", "Posts, DMs and email", "Connections", "Also in force"]);
    expect(document.querySelector(".page-vantage")).toHaveTextContent("7 tools · 3 can't be taken back");
  });

  it("says what each kind of action does today, with the connections' tools as its examples", async () => {
    await mount();
    expect(within(rowOf("Reading")).getByText("1 without asking · 2 ask")).toBeInTheDocument();
    expect(within(rowOf("Reading")).getByText("stub: read thing · Documents: docs read · Documents: docs list")).toBeInTheDocument();
    expect(within(rowOf("Things that can't be taken back")).getByText("Asks each time")).toBeInTheDocument();
    expect(within(rowOf("Changing files and records in this space")).getByText("Nothing a role here can call does this")).toBeInTheDocument();
  });

  it("draws Realm's toolsets as ONE connection, and each server as its own", async () => {
    await mount();
    // THE MUTANT: a row per Realm toolset — fifteen built-ins burying the servers the person connected.
    const names = [...document.querySelectorAll(".tv-name")].map((n) => n.textContent);
    expect(names.slice(0, 3)).toEqual(["Realm", "stub", "offline"]);
    expect(within(rowOf("Realm")).getByText("3 tools · 1 can't be taken back")).toBeInTheDocument();
    expect(within(rowOf("offline")).getByText("Not reached just now")).toBeInTheDocument();
    expect(within(rowOf("offline")).getByRole("button")).toBeDisabled();
  });

  it("unfolds a server's tools, riskiest first, each with its class, who said so and what it does today", async () => {
    await mount();
    const stub = within(rowOf("stub")).getByRole("button");
    expect(stub).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(stub);
    expect(stub).toHaveAttribute("aria-expanded", "true");
    const tools = [...document.querySelectorAll(".tpol-tool")].map((li) => [li.querySelector(".settings-row-name")!.textContent, li.querySelector(".tpol-value")!.textContent]);
    expect(tools).toEqual([["send quietly", "Can't be taken back"], ["send thing", "Can't be taken back"], ["save thing", "Can be undone"], ["read thing", "Reads"]]);
    expect(screen.getByText("Its server labels it read-only or local; Realm reads “send” · Asks each time")).toBeInTheDocument();
    expect(screen.getByText("No label, so treated as something that can't be taken back · Asks each time")).toBeInTheDocument();
  });

  it("offers nothing that changes anything: its only buttons unfold a connection or go to the Vault", async () => {
    const { store } = await mount(true);
    expect(within(rowOf("Outward actions")).getByText("Held")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    const buttons = screen.getAllByRole("button");
    expect(buttons.every((b) => b.hasAttribute("aria-expanded") || b.textContent?.includes("Vault"))).toBe(true);
    fireEvent.click(within(rowOf("Sign-ins and keys")).getByRole("button"));
    expect(store.getState().spacePageTab[S]).toBe("vault");
  });
});

describe("policies-format", () => {
  it("says one phrase when a class's tools agree and the split when they do not", () => {
    // THE MUTANT: a mixed class drawn as "Without asking" — the reading row would claim Gmail's reads run unasked.
    expect(classToday([{ asksToday: false }, { asksToday: true }])).toBe("1 without asking · 1 ask");
    expect(classToday([{ asksToday: false }])).toBe("Without asking");
    expect(classToday([{ asksToday: true }])).toBe("Asks each time");
  });

  it("counts the unclassified apart from the rest of what can't be taken back", () => {
    expect(connectorSummary(VIEW.connectors[2]!)).toBe("4 tools · 1 can't be taken back · 1 Realm can't classify");
  });

  it("names an unconfirmed lowering and a read that still asks first", () => {
    expect(toolNote({ name: "acme" }, tool("update_deal", { source: "unclassified", class: "irreversible-external", overrideIgnored: true })))
      .toBe("No label, so treated as something that can't be taken back · your lower class is not confirmed on this Mac");
    expect(toolNote({ name: "Realm" }, tool("docs_list", { source: "realm", asksFirst: "it makes the space's Documents workspace the first time" })))
      .toBe("asks first: it makes the space's Documents workspace the first time");
  });

  it("states today's pacing from the act service's own numbers", () => {
    expect(ACT_ROWS).toEqual([
      { label: "Posts", detail: "3 a day per account · 2 h apart · 8 AM–10 PM" },
      { label: "DMs", detail: "15 a day per account · 3 min apart · 8 AM–10 PM" },
      { label: "Email", detail: "20 a day per account · 1 min apart · 8 AM–10 PM" },
    ]);
  });

  it("drops a word a Realm toolset's name already says", () => {
    expect(toolLabel("browser_list", "Browser")).toBe("list");
    expect(toolLabel("agent_run", "Agents")).toBe("run");
    expect(toolLabel("docs_read", "Documents")).toBe("docs read");
    expect(toolLabel("save_issue")).toBe("save issue");
    expect(toolLabel("vault", "Vault")).toBe("vault");
  });

  it("lists every class, reading first", () => {
    expect(classRows([]).map((r) => r.class)).toEqual(["read", "internal-write", "reversible-external", "irreversible-external"]);
  });
});

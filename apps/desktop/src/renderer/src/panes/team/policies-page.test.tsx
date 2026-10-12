import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CLASS_FLOORS, type TeamPolicies, type TeamPolicyInput, type TeamPolicyRow, type TeamPolicyTool } from "@realm/contracts";
import { RpcError } from "../../rpc/client";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, teamRole, teamSpace } from "../../state/store.test-fakes";
import { POLICIES_NO_AGENT, PoliciesPage } from "./PoliciesPage";
import { setPoliciesClient, type PoliciesClient } from "./policies-client";
import { ACT_ROWS, capsLine, checksLine, classRows, classToday, connectorSummary, rowInForce, toolLabel, toolNote } from "./policies-format";

/**
 * The team's Policies page: the four kinds of action, the team's posts, DMs and email, Realm's own tools
 * as one connection and each server's tools under it — every rule a menu of decisions. A tightening
 * writes at once; a loosening opens the warning sheet, and only its button asks main to press (macOS)
 * before the write. The mutants are named per test.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setPoliciesClient(null); });

const S = "01J00000000000000000SPACE1";
const tool = (name: string, over: Partial<TeamPolicyTool>): TeamPolicyTool => {
  const cls = over.class ?? "read";
  const decision = over.decision ?? CLASS_FLOORS[cls];
  return { tool: name, class: cls, source: "server", verb: name.split("_")[0]!, floor: null, overrideIgnored: false, asksFirst: null,
    asksToday: decision !== "auto", decision, decidedBy: "floor", unconfirmed: false, ...over };
};
const policyRow = (over: Partial<TeamPolicyRow>): TeamPolicyRow => ({
  id: `row-${over.scope}-${over.scopeKey}`, spaceId: S, scope: "class", scopeKey: "read", decision: "auto", caps: {}, checks: [],
  setBy: "user", sealed: true, createdAt: 1, updatedAt: 1, ...over,
});

const VIEW: TeamPolicies = {
  spaceId: S,
  spaceName: "Versed",
  profileId: "p1",
  sealsChecked: true,
  rows: [],
  connectors: [
    { connector: "realm:realm-docs", kind: "realm", name: "Documents", icon: null, reached: true, tools: [
      tool("docs_read", { source: "realm", asksToday: false }),
      tool("docs_list", { source: "realm", asksFirst: "it makes the space's Documents workspace the first time", decision: "ask" }),
    ] },
    { connector: "realm:realm-vault", kind: "realm", name: "Vault", icon: null, reached: true, tools: [
      tool("vault_http", { source: "realm", class: "irreversible-external" }),
    ] },
    { connector: "mcp:STUB", kind: "server", name: "stub", icon: null, reached: true, tools: [
      tool("read_thing", { asksToday: true }),
      tool("save_thing", { class: "reversible-external" }),
      tool("send_thing", { class: "irreversible-external", source: "unclassified" }),
      tool("send_quietly", { class: "irreversible-external", floor: "send" }),
    ] },
    { connector: "mcp:GONE", kind: "server", name: "offline", icon: null, reached: false, tools: [] },
  ],
};

type Fake = { [K in keyof PoliciesClient]: ReturnType<typeof vi.fn> } & { order: string[] };

/** A client that records what was called, in order; `over` replaces any one of its answers. */
function fakeClient(view: TeamPolicies, over: Partial<PoliciesClient> = {}): Fake {
  const order: string[] = [];
  const f = {
    order,
    view: vi.fn(async () => view),
    set: vi.fn(async (row: TeamPolicyInput) => { order.push("set"); return policyRow({ ...row, sealed: true }); }),
    setToolClass: vi.fn(async (row: { class: TeamPolicyTool["class"] }) => { order.push("setToolClass"); return { class: row.class, sealed: true }; }),
    press: vi.fn(async () => { order.push("press"); return { ok: true as const }; }),
  };
  for (const [k, fn] of Object.entries(over)) (f as Record<string, unknown>)[k] = vi.fn(async (...a: unknown[]) => { order.push(k); return (fn as (...x: unknown[]) => unknown)(...a); });
  return f as unknown as Fake;
}

async function mount({ held = false, view = VIEW, over = {} as Partial<PoliciesClient> } = {}) {
  const client = fakeClient(view, over);
  setPoliciesClient(client as unknown as PoliciesClient);
  const api = fakeApi({ profiles: [profile("p1", "Work")], spaces: [space(S, "p1", "Versed")], teams: [{ ...teamSpace(S, [teamRole("01J0000000000000000ANALYST", S, "Growth Analyst")]), actsHeld: held }] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  render(<StoreContext.Provider value={store}><PoliciesPage spaceId={S} team={store.getState().teams[S]!} /></StoreContext.Provider>);
  await screen.findByText("By kind of action");
  return { store, client };
}

const rowOf = (text: string) => screen.getByText(text).closest("li")!;
const openMenu = () => document.querySelector<HTMLElement>('[role="menu"]:not([data-closing])')!;
const menuItems = () => [...openMenu().querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
const menuNames = () => menuItems().map((b) => b.querySelector(".menu-label")!.textContent);
const picksOf = (text: string) => [...rowOf(text).querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')];
/** Opens the `which`th menu on the row that says `text`. */
const openPick = (text: string, which = 0) => fireEvent.click(picksOf(text)[which]!);
/** Opens it and picks `choice`. */
function choose(text: string, choice: string, which = 0) {
  openPick(text, which);
  const item = menuItems().find((b) => b.querySelector(".menu-label")!.textContent === choice);
  if (!item) throw new Error(`No “${choice}” in ${JSON.stringify(menuNames())}`);
  fireEvent.click(item);
}
const expand = (name: string) => fireEvent.click(within(rowOf(name)).getAllByRole("button").find((b) => b.hasAttribute("aria-expanded") && !b.hasAttribute("aria-haspopup"))!);
const sheet = () => document.querySelector<HTMLElement>(".sheet") ?? screen.getByRole("dialog");

const classRow = (cls: string) => document.querySelector<HTMLElement>(`li[data-class="${cls}"]`)!;
const classPick = (cls: string) => classRow(cls).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
function chooseClass(cls: string, choice: string) {
  fireEvent.click(classPick(cls));
  // A menu picked from before is still closing (no animationend in jsdom): the press closed it, so press again.
  if (!openMenu()) fireEvent.click(classPick(cls));
  const item = menuItems().find((b) => b.querySelector(".menu-label")!.textContent === choice);
  if (!item) throw new Error(`No “${choice}” in ${JSON.stringify(menuNames())}`);
  fireEvent.click(item);
}
const button = (name: string) => within(sheet()).getByRole("button", { name });

describe("PoliciesPage", () => {
  it("shows the value in force on every rule, and offers no “Without asking” for a whole kind that can't be taken back", async () => {
    await mount();
    expect(classPick("read").textContent).toBe("Without asking");
    expect(classPick("reversible-external").textContent).toBe("Ask each time");
    fireEvent.click(classPick("irreversible-external"));
    // THE MUTANT: every decision offered — a whole class of sends one menu pick from going unasked.
    expect(menuNames()).toEqual(["Ask each time", "You approve, then press each one", "Never"]);
  });

  it("tightens at once, with no sheet and no press", async () => {
    const { client } = await mount();
    chooseClass("internal-write", "Never");
    await waitFor(() => expect(client.order).toEqual(["set"]));
    expect(client.set).toHaveBeenCalledWith({ spaceId: S, scope: "class", scopeKey: "internal-write", decision: "block", caps: {}, checks: [] });
    expect(document.querySelector(".sheet")).toBeNull();
  });

  it("asks first on a loosening: the sheet's button presses, and only then is the row written", async () => {
    const { client } = await mount();
    chooseClass("reversible-external", "Without asking");
    await waitFor(() => expect(sheet()).toBeInTheDocument());
    // THE MUTANT: a loosening written on the menu pick, like a tightening — no warning, no macOS.
    expect(client.order).toEqual([]);
    expect(within(sheet()).getByRole("spinbutton")).toHaveValue(20);
    fireEvent.click(button("Allow, up to 20 a day"));
    await waitFor(() => expect(client.order).toEqual(["press", "set"]));
    const row = { spaceId: S, scope: "class", scopeKey: "reversible-external", decision: "auto", caps: { perDay: 20, gapMs: 60_000 }, checks: [] };
    expect(client.press).toHaveBeenCalledWith({ kind: "policy", row, reason: expect.stringContaining("up to 20 a day") });
    expect(client.set).toHaveBeenCalledWith(row);
  });

  it("writes nothing on Cancel, nor when macOS does not confirm — and says why", async () => {
    const { client } = await mount({ over: { press: async () => ({ ok: false as const, error: "macOS did not confirm it was you, so nothing changed." }) } });
    chooseClass("reversible-external", "Without asking");
    fireEvent.click(button("Cancel"));
    expect(document.querySelector(".sheet")).toBeNull();
    chooseClass("reversible-external", "Without asking");
    fireEvent.click(button("Allow, up to 20 a day"));
    await waitFor(() => expect(within(sheet()).getByRole("alert")).toHaveTextContent("macOS did not confirm"));
    expect(client.order).toEqual(["press"]);
  });

  it("lets one tool that can't be taken back go without a click only with a daily limit at or under the ceiling", async () => {
    const { client } = await mount();
    expand("stub");
    choose("send quietly", "Without asking");
    await waitFor(() => expect(sheet()).toBeInTheDocument());
    const input = within(sheet()).getByRole("spinbutton");
    // THE MUTANT: a limit past the code's ceiling taken to macOS — the server would refuse it after the press.
    fireEvent.change(input, { target: { value: "21" } });
    expect(within(sheet()).getByRole("alert")).toHaveTextContent("more than 20 times a day");
    expect(button("Allow, up to 21 a day")).toBeDisabled();
    fireEvent.change(input, { target: { value: "" } });
    expect(button("Allow without asking")).toBeDisabled();
    fireEvent.change(input, { target: { value: "5" } });
    expect(within(sheet()).getByText(/can't be taken back/)).toBeInTheDocument();
    fireEvent.click(button("Allow, up to 5 a day"));
    await waitFor(() => expect(client.order).toEqual(["press", "set"]));
    expect(client.set).toHaveBeenCalledWith({ spaceId: S, scope: "tool", scopeKey: "mcp:STUB#send_quietly", decision: "auto", caps: { perDay: 5, gapMs: 60_000 }, checks: [] });
  });

  it("opens the sheet when the server holds that a pick which looked tighter loosens after all", async () => {
    const { client } = await mount({ over: { set: async () => { throw new RpcError("POLICY_NEEDS_PRESS", "needs a press"); } } });
    chooseClass("read", "Ask each time");
    await waitFor(() => expect(sheet()).toBeInTheDocument());
    expect(client.order).toEqual(["set"]);
  });

  it("raises a tool's class at once, and takes a lowering to the sheet", async () => {
    const stub = { ...VIEW.connectors[2]!, tools: [...VIEW.connectors[2]!.tools, tool("note_thing", { source: "you", class: "read" })] };
    const { client } = await mount({ view: { ...VIEW, connectors: [VIEW.connectors[0]!, stub] } });
    expand("stub");
    // THE MUTANT: a lowering written at once — a tool said to "only read" would go unasked with no press.
    choose("send thing", "Only reads", 0);
    await waitFor(() => expect(sheet()).toBeInTheDocument());
    expect(client.order).toEqual([]);
    fireEvent.click(button("Cancel"));
    choose("note thing", "Can't be taken back", 0);
    await waitFor(() => expect(client.order).toEqual(["setToolClass"]));
    expect(client.setToolClass).toHaveBeenCalledWith({ spaceId: S, connector: "mcp:STUB", tool: "note_thing", class: "irreversible-external" });
    expect(document.querySelector(".sheet")).toBeNull();
  });

  it("puts every control that changes a rule, and the sheet, out of an agent's reach", async () => {
    await mount();
    expand("stub");
    const picks = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')];
    expect(picks.length).toBeGreaterThan(8);
    // THE MUTANT: a pick without `data-no-agent` — an agent driving Realm's window could press it.
    expect(picks.filter((b) => b.dataset.noAgent !== POLICIES_NO_AGENT)).toEqual([]);
    openPick("send quietly");
    expect(menuItems().every((b) => b.dataset.noAgent === POLICIES_NO_AGENT)).toBe(true);
    fireEvent.keyDown(openMenu(), { key: "Escape" });
    chooseClass("reversible-external", "Without asking");
    await waitFor(() => expect(sheet()).toBeInTheDocument());
    expect(sheet().querySelector(".sheet-body > [data-no-agent]")).not.toBeNull();
    expect(sheet().querySelector(".sheet-foot > [data-no-agent]")).not.toBeNull();
  });

  it("reads a looser row with no seal as the floor, and says it is not confirmed", async () => {
    await mount({ view: { ...VIEW, rows: [policyRow({ scope: "class", scopeKey: "reversible-external", decision: "auto", caps: { perDay: 9 }, sealed: false })] } });
    expect(classPick("reversible-external").textContent).toBe("Ask each time");
    expect(within(classRow("reversible-external")).getByText("Not confirmed on this Mac")).toBeInTheDocument();
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

  it("says a row's limits and checks in a line, and reads a looser row as the floor until its seal checks out", () => {
    expect(capsLine({ perDay: 3, gapMs: 7_200_000, window: { start: 8, end: 22 } })).toBe("3 a day per account · 2 h apart · 8 AM–10 PM");
    expect(capsLine({})).toBe("");
    expect(checksLine([{ id: "consent-on-record" }, { id: "disclosure" }])).toBe("Checks: consent on the record · #ad or the platform's label");
    const loose = policyRow({ scope: "class", scopeKey: "reversible-external", decision: "auto", sealed: true });
    // THE MUTANT: a sealed-looking row trusted before main has checked its seal.
    expect(rowInForce(loose, "ask", false)).toEqual({ decision: "ask", unconfirmed: true });
    expect(rowInForce(loose, "ask", true)).toEqual({ decision: "auto", unconfirmed: false });
    expect(rowInForce({ ...loose, sealed: false }, "ask", true)).toEqual({ decision: "ask", unconfirmed: true });
    expect(rowInForce({ ...loose, decision: "block", sealed: false }, "ask", true)).toEqual({ decision: "block", unconfirmed: false });
  });

  it("lists every class, reading first", () => {
    expect(classRows([]).map((r) => r.class)).toEqual(["read", "internal-write", "reversible-external", "irreversible-external"]);
  });
});

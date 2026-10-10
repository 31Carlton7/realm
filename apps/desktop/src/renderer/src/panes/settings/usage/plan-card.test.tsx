import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { PlanLimits } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../../state/store";
import { fakeApi } from "../../../state/store.test-fakes";
import { PlanCard } from "./PlanCard";

/**
 * The plan card's whole job is to not overstate. Every test here is a way it could read as "you have
 * plenty left" when the truth is "nobody knows" — a zeroed bar, a missing provider, a window the
 * provider named without a number.
 */
const row = (over: Partial<PlanLimits> & { agentKind: string }): PlanLimits => ({
  subscriptionType: null, organization: null, windows: [], alert: "none", alertWindow: null,
  unavailable: null, detail: null, ts: 1, ...over,
});

const win = (id: string, label: string, utilization: number | null, resetsAt: number | null = null) =>
  ({ id, label, utilization, resetsAt });

async function mount(rows: PlanLimits[]) {
  const api = fakeApi();
  api.planLimitRows.push(...rows);
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshPlanLimits();
  render(<StoreContext.Provider value={store}><PlanCard /></StoreContext.Provider>);
  return { api, store };
}

const bars = () => Array.from(document.querySelectorAll(".plan-window"));
const meters = () => Array.from(document.querySelectorAll<HTMLElement>(".plan-track"));

describe("the plan card", () => {
  it("names the plan the way a person would say it, provider first", async () => {
    await mount([row({ agentKind: "claude", subscriptionType: "max", windows: [win("five_hour", "5-hour", 12)] })]);
    expect(await screen.findByText("Claude Max")).toBeInTheDocument();
  });

  it("draws each window as a meter carrying its real percentage", async () => {
    await mount([row({
      agentKind: "claude", subscriptionType: "max",
      windows: [win("five_hour", "5-hour", 31), win("seven_day", "Weekly", 78)],
    })]);
    await waitFor(() => expect(meters()).toHaveLength(2));
    expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["78", "31"]);
  });

  /* Fullest first: the card answers "what stops me next", and that is the closest window to its
   * ceiling — not whichever one the provider happened to list first. */
  it("orders windows by how close they are to the limit", async () => {
    await mount([row({
      agentKind: "claude", subscriptionType: "max",
      windows: [win("five_hour", "5-hour", 10), win("seven_day", "Weekly", 90), win("model:Fable", "Fable weekly", 50)],
    })]);
    await waitFor(() => expect(bars()).toHaveLength(3));
    expect(bars().map((b) => b.querySelector(".plan-window-label")?.textContent)).toEqual(["Weekly", "Fable weekly", "5-hour"]);
  });

  /* The single most expensive wrong thing this card could say. A window the provider named without a
   * utilization has no bar at all — a 0% bar would be a number Realm invented. */
  it("says a window is not reported instead of drawing it at zero", async () => {
    await mount([row({ agentKind: "claude", subscriptionType: "max", windows: [win("seven_day", "Weekly", null)] })]);
    expect(await screen.findByText("not reported")).toBeInTheDocument();
    expect(meters()).toHaveLength(0);
  });

  it("distinguishes an account with no plan quota from one at zero usage", async () => {
    await mount([row({ agentKind: "claude", unavailable: "not-on-a-plan" })]);
    expect(await screen.findByText(/bills per token/)).toBeInTheDocument();
    expect(meters()).toHaveLength(0);
  });

  it("shows the provider's own reason beside an unreadable account", async () => {
    await mount([row({ agentKind: "claude", unavailable: "unreadable", detail: "out_of_credits" })]);
    expect(await screen.findByText(/out_of_credits/)).toBeInTheDocument();
  });

  it("never names an agent nobody can run", async () => {
    /* `fake` is a real AgentKind — it is the harness the suite drives — and the service answers for
       every kind there is, so the silent line read "…, Hermes, Fake — their protocols do not report
       one." A card that lists a test double as one of your agents is a card you stop believing. */
    await mount([row({ agentKind: "claude", windows: [win("five_hour", "5-hour", 12)] }), row({ agentKind: "fake" })]);
    await screen.findByText(/5-hour/);
    expect(screen.queryByText(/Fake/)).toBeNull();
  });

  /* Twelve stacked "does not report" rows would be the tiny grey copy the guidelines reject, and the
   * fact is identical for all of them — so it is one sentence naming them. */
  it("collapses every non-reporting provider into one line naming them", async () => {
    await mount([
      row({ agentKind: "claude", subscriptionType: "max", windows: [win("five_hour", "5-hour", 10)] }),
      row({ agentKind: "acp:cursor", unavailable: "unsupported" }),
      row({ agentKind: "acp:gemini", unavailable: "unsupported" }),
    ]);
    const note = await screen.findByText(/protocols do not report one/);
    expect(note.textContent).toContain("Cursor");
    expect(note.textContent).toContain("Gemini");
    // And they get no bars of their own.
    await waitFor(() => expect(meters()).toHaveLength(1));
  });

  it("tones only the window the provider named, not every window on the account", async () => {
    await mount([row({
      agentKind: "claude", subscriptionType: "max", alert: "approaching", alertWindow: "seven_day",
      windows: [win("five_hour", "5-hour", 20), win("seven_day", "Weekly", 92)],
    })]);
    await waitFor(() => expect(bars()).toHaveLength(2));
    const alerted = bars().filter((b) => b.hasAttribute("data-alerted"));
    expect(alerted).toHaveLength(1);
    expect(alerted[0]!.querySelector(".plan-window-label")?.textContent).toBe("Weekly");
  });

  it("says when a window resets, as a time rather than a raw stamp", async () => {
    const noon = new Date(); noon.setHours(12, 20, 0, 0);
    await mount([row({ agentKind: "claude", subscriptionType: "max", windows: [win("five_hour", "5-hour", 31, noon.getTime())] })]);
    expect(await screen.findByText(/resets Today at/)).toBeInTheDocument();
  });
});

/** A Claude config folder a profile names, inside the home folder the fake server reports. */
const WORK_HOME = "/Users/carlton/.claude-work";
/** Claude on two accounts: the one the default folder is signed in to, and a named folder's. */
const TWO_ACCOUNTS: PlanLimits[] = [
  row({ agentKind: "claude", subscriptionType: "max", home: null, windows: [win("five_hour", "5-hour", 12)] }),
  row({ agentKind: "claude", subscriptionType: "team", home: WORK_HOME, windows: [win("five_hour", "5-hour", 40)] }),
];
/** Codex's one account, which no folder decides. */
const CODEX = row({ agentKind: "codex", subscriptionType: "pro", windows: [win("primary", "5-hour", 5)] });

/** The account cards drawn, top to bottom. */
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".plan-account"));
/** What a card's head says, an entry for each thing on it. */
const headOf = (card: HTMLElement): string[] => Array.from(card.querySelectorAll(".plan-account-head > *")).map((el) => el.textContent ?? "");
/** The folder a card's head names, or null where it names none. */
const folderOn = (card: HTMLElement) => card.querySelector(".plan-account-home");

describe("the plan card where Claude runs on more than one account", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("draws a card for each account on a key of its own, and keeps one card to an account when the rows change", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = await mount(TWO_ACCOUNTS);
    await waitFor(() => expect(cards()).toHaveLength(2));
    act(() => store.getState().applyPlanLimits([CODEX, ...TWO_ACCOUNTS]));
    expect(cards().map((card) => headOf(card)[1])).toEqual(["Codex Pro", "Claude Max", "Claude Team"]);
    expect(errors.mock.calls).toEqual([]);
  });

  it("names the folder on each Claude card's head: a path as a person writes it, in the code face, and the default folder in words", async () => {
    await mount(TWO_ACCOUNTS);
    await waitFor(() => expect(cards()).toHaveLength(2));
    const [onDefault, onWork] = cards().map(folderOn);
    expect(onDefault?.textContent).toBe("default folder");
    expect(onDefault?.tagName).toBe("SPAN");
    expect(onWork?.textContent).toBe("~/.claude-work");
    expect(onWork?.tagName).toBe("CODE");
  });

  it("holds a path whole on its tooltip, for a head too narrow to show all of it", async () => {
    await mount(TWO_ACCOUNTS);
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(folderOn(cards()[1]!)).toHaveAttribute("title", "~/.claude-work");
  });

  it("names no folder on another agent's card", async () => {
    await mount([...TWO_ACCOUNTS, CODEX]);
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(folderOn(cards()[2]!)).toBeNull();
  });

  it("keeps the head it always had where one Claude account reports, whichever folder it is kept in", async () => {
    await mount([row({ agentKind: "claude", subscriptionType: "team", home: WORK_HOME, windows: [win("five_hour", "5-hour", 40)] })]);
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(headOf(cards()[0]!)).toEqual(["Claude", "Claude Team"]);
  });
});

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    const alerted = bars().filter((b) => b.hasAttribute("data-alert"));
    expect(alerted).toHaveLength(1);
    expect(alerted[0]!.querySelector(".plan-window-label")?.textContent).toBe("Weekly");
  });

  it("says when a window resets as a countdown and a time, never a raw stamp", async () => {
    const soon = Date.now() + (72 * 60 + 30) * 1000;
    await mount([row({ agentKind: "claude", subscriptionType: "max", ts: Date.now(), windows: [win("five_hour", "5-hour", 31, soon)] })]);
    expect(await screen.findByText(/^Resets in 1h 12m · (Today|Tomorrow) at /)).toBeInTheDocument();
  });

  it("leads with what is LEFT, and states used, left and the reset in the meter's own words", async () => {
    const soon = Date.now() + 3 * 3_600_000;
    await mount([row({ agentKind: "claude", subscriptionType: "max", ts: Date.now(), windows: [win("five_hour", "5-hour", 62, soon)] })]);
    expect(await screen.findByText("38% left")).toBeInTheDocument();
    expect(screen.getByText("62% used")).toBeInTheDocument();
    expect(meters()[0]!.getAttribute("aria-valuetext")).toMatch(/^62% used, 38% left\. Resets in 2h 59m/);
  });

  it("marks where even spending would be, and says whether the window is ahead of it", async () => {
    // Two hours into five is 40% of the window; 62% used is ahead of that.
    const soon = Date.now() + 3 * 3_600_000;
    await mount([row({ agentKind: "claude", subscriptionType: "max", ts: Date.now(), windows: [win("five_hour", "5-hour", 62, soon)] })]);
    await screen.findByText("ahead of pace");
    const tick = document.querySelector<HTMLElement>(".plan-pace-tick");
    expect(parseFloat(tick!.style.left)).toBeCloseTo(40, 0);
  });

  it("draws a window that has reset since its reading as reset, not at its old figure", async () => {
    // The reading is kept across launches. "92% used" on a window that reset at midnight would send
    // someone to wait for quota they already have.
    await mount([row({ agentKind: "claude", subscriptionType: "max", ts: Date.now() - 6 * 3_600_000,
      windows: [win("five_hour", "5-hour", 92, Date.now() - 3_600_000)] })]);
    expect(await screen.findByText("reset since this reading")).toBeInTheDocument();
    expect(meters()).toHaveLength(0);
    expect(screen.queryByText(/92%/)).toBeNull();
  });

  it("says how old a kept reading is", async () => {
    await mount([row({ agentKind: "codex", subscriptionType: "plus", ts: Date.now() - 40 * 60_000,
      windows: [win("primary", "5-hour", 17, Date.now() + 3_600_000)] })]);
    expect(await screen.findByText("as of 40m ago")).toBeInTheDocument();
  });
});

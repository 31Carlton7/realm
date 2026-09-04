import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UsageSummary } from "@realm/contracts";
import { UsagePanel } from "./UsagePanel";
import { StoreContext, createAppStore } from "../../../state/store";
import { emptyUsageSummary, fakeApi, usageTotals, type FakeData } from "../../../state/store.test-fakes";

const day = (d: number) => new Date(2026, 8, d).getTime();

/** A realistic answer: one Claude session with stated dollars, one Codex session priced from the
 *  catalog, and a Cursor session that reports nothing at all — the three cases the page exists to
 *  keep apart. */
const summary = (extra: Partial<UsageSummary> = {}): UsageSummary => emptyUsageSummary({
  from: day(1), to: day(3), bucket: "day", buckets: [day(1), day(2), day(3)],
  totals: usageTotals({ costUsd: 12.5, reportedUsd: 10, estimatedUsd: 2.5, inputTokens: 900_000, outputTokens: 100_000, turns: 14, sessions: 3, unmeasuredSessions: 1 }),
  series: [
    { bucket: day(1), totals: usageTotals({ costUsd: 4, inputTokens: 300_000 }) },
    { bucket: day(2), totals: usageTotals({ costUsd: 0, inputTokens: 0 }) },
    { bucket: day(3), totals: usageTotals({ costUsd: 8.5, inputTokens: 700_000 }) },
  ],
  breakdowns: {
    agent: [
      { key: "claude", label: "Claude", colorIndex: 0, totals: usageTotals({ costUsd: 10, reportedUsd: 10, inputTokens: 600_000, outputTokens: 60_000, sessions: 1 }), buckets: [{ costUsd: 4, tokens: 200_000 }, { costUsd: 0, tokens: 0 }, { costUsd: 6, tokens: 460_000 }] },
      { key: "codex", label: "Codex", colorIndex: 1, totals: usageTotals({ costUsd: 2.5, estimatedUsd: 2.5, inputTokens: 300_000, outputTokens: 40_000, sessions: 1 }), buckets: [{ costUsd: 0, tokens: 100_000 }, { costUsd: 0, tokens: 0 }, { costUsd: 2.5, tokens: 240_000 }] },
      { key: "acp:cursor", label: "Cursor", colorIndex: 2, totals: usageTotals({ sessions: 1, unmeasuredSessions: 1 }), buckets: [{ costUsd: 0, tokens: 0 }, { costUsd: 0, tokens: 0 }, { costUsd: 0, tokens: 0 }] },
    ],
    model: [], space: [], environment: [],
  },
  sessions: [
    { id: "sess-1", title: "Refactor the pane host", spaceId: "s1", spaceName: "Realm", agentKind: "claude", model: "claude-opus-5",
      totals: usageTotals({ costUsd: 10, reportedUsd: 10, inputTokens: 600_000, outputTokens: 60_000, turns: 9, sessions: 1 }), createdAt: day(1), updatedAt: day(3) },
  ],
  activity: { toolCalls: 240, userMessages: 31, errors: 2, mcpCalls: 18, mcpFailures: 3, mcpMedianMs: 42,
    topTools: [{ name: "Bash", calls: 120 }], topMcpServers: [{ name: "realm-browser", calls: 12, failures: 3 }] },
  unmeasuredKinds: ["acp:cursor"],
  unpricedModels: ["some-private-model"],
  ...extra,
});

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({ usageSummary: summary(), ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><UsagePanel /></StoreContext.Provider>);
  await screen.findByText("Spend in range");
  return { store, api, ...r };
}

describe("the Usage panel", () => {
  it("reads on mount, and again when the range changes — the filter row scopes everything below it", async () => {
    const { api } = await mount();
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("usageSummary:"))).toHaveLength(1));
    // 90 days is too many columns to draw daily, so the bucket widens with the range.
    fireEvent.click(screen.getByRole("radio", { name: "Last 90 days" }));
    await waitFor(() => expect(api.calls).toContain("usageSummary:week:*"));
  });

  it("scopes to a single space when one is picked", async () => {
    const { api } = await mount();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "s1" } });
    await waitFor(() => expect(api.calls.some((c) => c.endsWith(":s1"))).toBe(true));
  });

  it("splits reported dollars from estimated ones, because they are different kinds of fact", async () => {
    await mount();
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00 reported/)).toBeInTheDocument();
    expect(screen.getByText(/\$2\.50 estimated/)).toBeInTheDocument();
  });

  it("says an engine that reports nothing reports NOTHING — never $0.00", async () => {
    // The page's central honesty rule. A zero here would be a claim about Cursor's spend, and a
    // false one; the table has to say the question cannot be answered.
    await mount();
    const row = screen.getByRole("row", { name: /Cursor/ });
    expect(within(row).getByText("not reported")).toBeInTheDocument();
    expect(within(row).queryByText("$0.00")).toBeNull();
    expect(within(row).getByText("engine reports none")).toBeInTheDocument();
  });

  it("names the engines behind the gap, and the models it could not price", async () => {
    await mount();
    const caveats = screen.getByLabelText("Why some numbers are missing");
    expect(within(caveats).getByText("Cursor")).toBeInTheDocument();
    expect(within(caveats).getByText(/ACP protocol/)).toBeInTheDocument();
    expect(within(caveats).getByText("some-private-model")).toBeInTheDocument();
  });

  it("ships a table twin of the chart, which is what makes the light palette legal", async () => {
    // Three light-mode slots sit below 3:1 on white (tokens.css). The relief obligation is a table
    // view or visible labels — remove this table and the palette stops being compliant, so the
    // table is load-bearing rather than a convenience.
    await mount();
    const table = screen.getByRole("table", { name: /Engine breakdown, as a table/ });
    expect(within(table).getByRole("row", { name: /Claude/ })).toBeInTheDocument();
    expect(within(table).getByText("reported")).toBeInTheDocument();
    expect(within(table).getByText("estimated")).toBeInTheDocument();
  });

  it("colours a row by the slot the SERVER assigned, not by its position after sorting", async () => {
    // Codex outspends nothing here, but the table sorts by spend while the chart stacks in intrinsic
    // order. If the swatch followed the table's row index the two would disagree on what colour
    // Codex is, on the same screen.
    await mount();
    const codexCell = within(screen.getByRole("table", { name: /Engine breakdown/ })).getByRole("rowheader", { name: /Codex/ });
    // colorIndex 1 → slot 2, whatever row the sort puts Codex in.
    expect(codexCell.querySelector(".usage-swatch")?.getAttribute("style")).toContain("--series-2");
    const claudeCell = within(screen.getByRole("table", { name: /Engine breakdown/ })).getByRole("rowheader", { name: /Claude/ });
    expect(claudeCell.querySelector(".usage-swatch")?.getAttribute("style")).toContain("--series-1");
  });

  it("switches the single axis between spend and tokens rather than growing a second one", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Spend over time" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Tokens" }));
    expect(screen.getByRole("heading", { name: "Tokens over time" })).toBeInTheDocument();
  });

  it("re-cuts the breakdown without another round trip — the buckets carry both metrics", async () => {
    const { api } = await mount();
    const before = api.calls.filter((c) => c.startsWith("usageSummary:")).length;
    fireEvent.click(screen.getByRole("radio", { name: "Model" }));
    fireEvent.click(screen.getByRole("radio", { name: "Tokens" }));
    expect(api.calls.filter((c) => c.startsWith("usageSummary:")).length).toBe(before);
  });

  it("gives keyboard readers the same readout the pointer gets", async () => {
    await mount();
    const stepper = screen.getByRole("slider", { name: /step through buckets/ });
    fireEvent.focus(stepper);
    // Focus lands on the newest bucket, which is where a reader looks first.
    await waitFor(() => expect(stepper).toHaveAttribute("aria-valuenow", "2"));
    fireEvent.keyDown(stepper, { key: "ArrowLeft" });
    expect(stepper).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(stepper, { key: "Home" });
    expect(stepper.getAttribute("aria-valuetext")).toMatch(/\$4\.00/);
  });

  it("holds the previous render while refetching instead of flashing a skeleton", async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(container.querySelector(".usage-panel")).toHaveAttribute("data-loading"));
    // The numbers stay on screen throughout — no layout jump, nothing to lose your place in.
    expect(screen.getByText("$12.50")).toBeInTheDocument();
  });
});

describe("the budget", () => {
  const withBudget = (monthlyUsd: number | null, monthSpendUsd = 60, projectedUsd: number | null = 120) =>
    summary({ budget: { budget: { monthlyUsd, thresholds: [0.5, 0.8, 1], includeEstimated: true }, monthSpendUsd, monthStart: day(1), projectedUsd } });

  it("draws no meter until a budget exists, but still reports the month's spend", async () => {
    await mount({ usageSummary: withBudget(null) });
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(/September so far: \$60\.00/)).toBeInTheDocument();
  });

  it("measures the meter against the budget, and says where the pace is heading", async () => {
    await mount({ usageSummary: withBudget(100) });
    const meter = screen.getByRole("meter", { name: /spend against budget/i });
    expect(meter).toHaveAttribute("aria-valuenow", "60");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByText(/On this pace, \$120\.00 by month end/)).toBeInTheDocument();
  });

  it("keeps the meter on the calendar month, not on the chart's range", async () => {
    // The chart says $12.50 in range; the month says $60. Both are true, and conflating them would
    // make the budget move whenever someone narrowed the chart.
    await mount({ usageSummary: withBudget(100) });
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText(/September so far: \$60\.00 of \$100\.00/)).toBeInTheDocument();
  });

  it("saves a ceiling and its thresholds, then re-reads so the page shows what actually stored", async () => {
    const { api } = await mount({ usageSummary: withBudget(null) });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Monthly ceiling/ }), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "125%" }));
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(api.calls).toContain("setUsageBudget:250"));
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("usageSummary:")).length).toBeGreaterThan(1));
  });

  it("says plainly that this is not a bill", async () => {
    await mount({ usageSummary: withBudget(100) });
    expect(screen.getByText(/It is not a bill/)).toBeInTheDocument();
  });
});

describe("activity — the half that covers every engine", () => {
  it("reports what Realm counted itself, including MCP failures", async () => {
    await mount();
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("240 tool calls")).toBeInTheDocument();
    expect(within(activity).getByText(/17% failed · 42ms median/)).toBeInTheDocument();
    expect(within(activity).getByText("realm-browser")).toBeInTheDocument();
    expect(within(activity).getByText("3 failed")).toBeInTheDocument();
  });
});

describe("the empty state", () => {
  it("says nothing has run rather than drawing an axis around no data", async () => {
    const api = fakeApi({ usageSummary: emptyUsageSummary() });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><UsagePanel /></StoreContext.Provider>);
    expect(await screen.findByText("Nothing ran in this range.")).toBeInTheDocument();
    expect(screen.getByText(/No engine in range reported or priced any spend/)).toBeInTheDocument();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ResourceReport } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { defaultResourcePolicies, emptyResourceReport, fakeApi, type FakeData } from "../../state/store.test-fakes";
import { RamPanel, bytesLabel, windowLabel } from "./RamPanel";

/**
 * Settings ▸ RAM. What must die: a total that is not the report's, a button offered for nothing it
 * could free, a window shown as set while a shorter one is in force, and a control beside another
 * app's name.
 */

afterEach(() => cleanup());

const GB = 1024 ** 3, MB = 1024 ** 2;
const REPORT: ResourceReport = {
  ...emptyResourceReport(),
  machine: { totalBytes: 24 * GB, availablePercent: 40, pressure: "warn", pressureWhy: "Swapping out 12 MB a second", swap: { usedBytes: 19 * GB, totalBytes: 20 * GB }, compressedBytes: 7 * GB, swapOutPerSecond: 12 * MB, load: [8.25, 6, 5], cpus: 14 },
  realm: { processes: 12, residentBytes: 2 * GB, footprintBytes: Math.round(4.2 * GB) },
  categories: [
    { category: "laya", processes: 1, residentBytes: 24 * MB, footprintBytes: Math.round(2.4 * GB) },
    { category: "engines", processes: 3, residentBytes: GB, footprintBytes: Math.round(1.3 * GB) },
  ],
  parts: [
    { id: "laya:laya", category: "laya", ownerId: "laya", label: "Laya", detail: "Shadow, ready", processes: 1, residentBytes: 24 * MB, footprintBytes: Math.round(2.4 * GB) },
    { id: "engines:s1", category: "engines", ownerId: "s1", label: "Fix the sidebar", detail: "Idle 42 min", processes: 2, residentBytes: 700 * MB, footprintBytes: 900 * MB },
    { id: "engines:s2", category: "engines", ownerId: "s2", label: "Write the tests", detail: "Working", processes: 1, residentBytes: 300 * MB, footprintBytes: 400 * MB },
  ],
  others: [{ name: "Google Chrome", processes: 67, residentBytes: 3 * GB, footprintBytes: 12 * GB }],
  freeable: { engines: { count: 1, bytes: 900 * MB }, simulators: { count: 0, bytes: 0 }, browsers: { count: 0, bytes: 0 }, laya: { count: 1, bytes: Math.round(2.4 * GB) } },
};

async function mount(over: FakeData = {}) {
  const api = fakeApi({ resourceReport: REPORT, ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><RamPanel /></StoreContext.Provider>);
  await screen.findByText(/Realm is holding/);
  return { api, store };
}

const row = (setting: string) => document.querySelector(`[data-setting="${setting}"]`) as HTMLElement;

describe("Settings ▸ RAM", () => {
  it("says what Realm holds beside how short the Mac is", async () => {
    await mount();
    expect(screen.getByText(/Realm is holding/).textContent).toBe("Realm is holding 4.2 GB");
    expect(screen.getByText("of this Mac's 24 GB · 12 processes")).toBeInTheDocument();
    expect(screen.getByText("Memory is short")).toBeInTheDocument();
    expect(screen.getByText("Swapping out 12 MB a second · 19 GB of 20 GB swap in use · load 8.3 on 14 cores")).toBeInTheDocument();
  });

  it("opens each category onto its parts, heaviest first, with what each is doing", async () => {
    await mount();
    const engines = screen.getByText("Engines").closest("details")!;
    expect(within(engines).getByText("1.3 GB")).toBeInTheDocument();
    fireEvent.click(within(engines).getByText("Engines"));
    const names = within(engines).getAllByText(/Fix the sidebar|Write the tests/).map((e) => e.textContent);
    expect(names).toEqual(["Fix the sidebar", "Write the tests"]);
    expect(within(engines).getByText("Idle 42 min")).toBeInTheDocument();
  });

  it("offers a button only where there is something idle to free, and says how much", async () => {
    const { api } = await mount();
    expect(within(row("ram-free-engines")).getByText("1 engine, 900 MB")).toBeInTheDocument();
    expect(within(row("ram-free-simulators")).getByRole("button", { name: "Shut down" })).toBeDisabled();
    expect(within(row("ram-free-laya")).getByText("1 process, 2.4 GB")).toBeInTheDocument();
    fireEvent.click(within(row("ram-free-engines")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(row("ram-free-engines")).getByText("Stopped 1 engine")).toBeInTheDocument());
    expect(api.calls).toContain("resourcesFree:engines");
    // …and the page reads the Mac again rather than showing what it was before.
    expect(api.calls.filter((c) => c === "resourcesSnapshot:true")).toHaveLength(1);
  });

  it("shows each window as set, and the shorter one in force while memory is short", async () => {
    const { api } = await mount({ resourcePolicies: { ...defaultResourcePolicies(), effective: { engines: 10, mcp: 10, laya: 10, simulators: 10, browsers: 10 } } });
    const engine = row("ram-engine-idle");
    expect(within(engine).getByRole("combobox", { name: "Stop an idle engine after" })).toHaveValue("30");
    expect(within(engine).getByText("10 minutes while memory is short")).toBeInTheDocument();
    // Laya's is 10 already: nothing is said.
    expect(within(row("ram-laya-idle")).queryByText(/while memory is short/)).toBeNull();
    fireEvent.change(within(engine).getByRole("combobox"), { target: { value: "0" } });
    await waitFor(() => expect(api.calls).toContain("resourcesSetPolicy:sessions.engineIdleMinutes:0"));
    expect(within(engine).getByRole("combobox")).toHaveValue("0");
    fireEvent.click(within(row("ram-adaptive")).getByRole("switch", { name: "Sooner when memory is short" }));
    await waitFor(() => expect(api.calls).toContain("resourcesSetPolicy:resources.adaptive:false"));
  });

  it("lists other apps by name and size only, with nothing to press", async () => {
    await mount();
    const others = document.querySelector(".ram-others") as HTMLElement;
    expect(within(others).getByText("Google Chrome")).toBeInTheDocument();
    expect(within(others).getByText("12 GB")).toBeInTheDocument();
    expect(within(others).queryByRole("button")).toBeNull();
  });

  it("says nothing until it has measured", async () => {
    const api = fakeApi({ resourceReport: REPORT });
    api.resourcesSnapshot = () => new Promise(() => {});
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><RamPanel /></StoreContext.Provider>);
    expect(screen.getByText("Measuring…")).toBeInTheDocument();
    expect(screen.queryByText(/Realm is holding/)).toBeNull();
  });
});

describe("the words it measures in", () => {
  it("writes sizes as Activity Monitor does, and windows in minutes and hours", () => {
    expect(bytesLabel(2.44 * GB)).toBe("2.4 GB");
    expect(bytesLabel(12.4 * GB)).toBe("12 GB");
    expect(bytesLabel(312 * MB)).toBe("312 MB");
    expect(bytesLabel(1000)).toBe("under 1 MB");
    expect(windowLabel(0)).toBe("Never");
    expect(windowLabel(1)).toBe("1 minute");
    expect(windowLabel(60)).toBe("1 hour");
    expect(windowLabel(120)).toBe("2 hours");
    expect(windowLabel(45)).toBe("45 minutes");
  });
});

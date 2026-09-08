import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Schedule } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { SchedulesPage, filterSchedules, scheduleState, whenLabel } from "./SchedulesPage";

afterEach(() => cleanup());

const DAY = 86_400_000;
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sch1", spaceId: "s1", title: "Morning triage", goal: "read the new issues",
  cron: "0 9 * * *", enabled: true, constraints: null,
  nextRunAt: Date.now() + DAY, lastRunAt: null, lastRunId: null, lastSkippedAt: null,
  createdAt: 1, updatedAt: 1, ...over,
});

async function mount(schedules: Schedule[]) {
  const api = fakeApi({ schedules });
  const store = createAppStore(api);
  await store.getState().boot();
  render(
    <StoreContext.Provider value={store}>
      <SchedulesPage item={item("i9", "s1", { kind: "schedules-page", refId: "00000000000000000000000006", title: "Scheduled tasks" })} visible />
    </StoreContext.Provider>,
  );
  await waitFor(() => expect(api.calls.some((c) => c.startsWith("listSchedules:"))).toBe(true));
  return { api, store };
}

const row = () => document.querySelector<HTMLElement>(".sched-row")!;

describe("whenLabel", () => {
  const now = new Date(2026, 8, 7, 12).getTime(); // a Monday
  it("reads a moment the way someone asks about one", () => {
    expect(whenLabel(new Date(2026, 8, 7, 9).getTime(), now)).toMatch(/^Today at /);
    expect(whenLabel(new Date(2026, 8, 8, 9).getTime(), now)).toMatch(/^Tomorrow at /);
    expect(whenLabel(new Date(2026, 8, 6, 9).getTime(), now)).toMatch(/^Yesterday at /);
    expect(whenLabel(new Date(2026, 8, 10, 9).getTime(), now)).toMatch(/^Thursday at /);
    expect(whenLabel(new Date(2026, 9, 20, 9).getTime(), now)).toMatch(/^Oct 20 at /);
  });
});

describe("the Scheduled tasks page", () => {
  it("lists what is armed, with the recurrence read back in words", () => {
    return mount([schedule()]).then(() => {
      expect(screen.getByText("Morning triage")).toBeInTheDocument();
      expect(screen.getByText("Every day at 09:00")).toBeInTheDocument();
      expect(within(row()).getByText(/^Next /)).toBeInTheDocument();
    });
  });

  it("says Paused rather than inventing a next time for a schedule that is off", async () => {
    // A switch that leaves a next time on screen looks like it did nothing.
    await mount([schedule({ enabled: false, nextRunAt: null })]);
    expect(within(row()).getByText("Paused")).toBeInTheDocument();
    expect(within(row()).queryByText(/^Next /)).toBeNull();
  });

  it("names a firing that was missed, instead of letting the last result stand in for it", async () => {
    // The named mutant: showing `lastRunAt` alone. A laptop that slept through Monday would then
    // present the previous week's result as this week's.
    await mount([schedule({ lastRunAt: Date.now() - 8 * DAY, lastSkippedAt: Date.now() - DAY })]);
    expect(within(row()).getByText(/^Missed /)).toBeInTheDocument();
    expect(within(row()).getByText(/^Last ran /)).toBeInTheDocument();
  });

  it("pausing writes through the store rather than only flipping a checkbox", async () => {
    const { api } = await mount([schedule()]);
    fireEvent.click(screen.getByRole("switch", { name: "Morning triage is on" }));
    await waitFor(() => expect(api.calls).toContain("updateSchedule:sch1"));
  });

  it("Run now goes through the method that leaves the clock alone", async () => {
    const { api } = await mount([schedule()]);
    fireEvent.click(screen.getByRole("button", { name: "Run Morning triage now" }));
    await waitFor(() => expect(api.calls).toContain("runScheduleNow:sch1"));
  });

  it("deleting takes two clicks", async () => {
    const { api } = await mount([schedule()]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Morning triage" }));
    expect(api.calls).not.toContain("deleteSchedule:sch1");
    fireEvent.click(screen.getByRole("button", { name: "Really delete Morning triage?" }));
    await waitFor(() => expect(api.calls).toContain("deleteSchedule:sch1"));
  });

  it("previews the first run before it is saved, and refuses to save an expression that never fires", async () => {
    // Showing the first occurrence is the only way to tell a right expression from a plausible one
    // at the moment you are writing it — which for unattended work is the last honest chance.
    await mount([]);
    fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly" } });
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "sweep" } });
    expect(screen.getByText(/^First run /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create schedule" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "0 9 30 2 *" } }); // February 30th
    expect(screen.getByText(/will never run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create schedule" })).toBeDisabled();
  });

  it("creates through the store and shows the new row", async () => {
    const { api } = await mount([]);
    fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly" } });
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "sweep the inbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => expect(api.calls).toContain("createSchedule:s1"));
    await waitFor(() => expect(screen.getByText("Nightly")).toBeInTheDocument());
  });

  it("says what the page is for when nothing is scheduled yet", async () => {
    await mount([]);
    expect(screen.getByText(/Nothing is scheduled here yet/)).toBeInTheDocument();
  });
});

describe("filtering a list of schedules", () => {
  const active = schedule({ id: "a", title: "Morning triage", goal: "read the new issues", enabled: true, nextRunAt: Date.now() + DAY });
  const paused = schedule({ id: "p", title: "Weekly digest", goal: "summarise the week", enabled: false, nextRunAt: null });
  const done = schedule({ id: "d", title: "Launch checklist", goal: "ship v2", enabled: true, nextRunAt: null });

  it("tells a finished schedule apart from a paused one", () => {
    /* Neither is going to fire again, and calling both "not active" would hide a task that has
       quietly finished for good behind one a user is deliberately holding — which is exactly the
       state where a silent failure goes unnoticed for weeks. */
    expect(scheduleState(active)).toBe("active");
    expect(scheduleState(paused)).toBe("paused");
    expect(scheduleState(done)).toBe("completed");
    // A paused schedule is paused whatever its next time says — the switch wins.
    expect(scheduleState(schedule({ enabled: false, nextRunAt: Date.now() + DAY }))).toBe("paused");
  });

  it("searches what a schedule DOES, not only what it was called", () => {
    // A user hunting for the schedule that reads their issues remembers the goal, not the title
    // they typed at 11pm three months ago.
    const all = [active, paused, done];
    expect(filterSchedules(all, "all", "issues").map((s) => s.id)).toEqual(["a"]);
    expect(filterSchedules(all, "all", "MORNING").map((s) => s.id)).toEqual(["a"]);
    // The cron's plain-English reading is searchable too, because that is how the row reads it out.
    expect(filterSchedules(all, "all", "").map((s) => s.id)).toEqual(["a", "p", "d"]);
  });

  it("applies the filter and the query together, so the chip counts cannot lie", () => {
    // THE mutant: count off the unfiltered list. A chip reading "Paused 1" beside a list of none is
    // a chip lying about what clicking it will show.
    const all = [active, paused, done];
    expect(filterSchedules(all, "paused", "").map((s) => s.id)).toEqual(["p"]);
    expect(filterSchedules(all, "paused", "issues")).toEqual([]);
  });

  it("empties the list rather than the page when nothing matches", async () => {
    await mount([active, paused]);
    fireEvent.change(screen.getByLabelText("Search schedules"), { target: { value: "zzz" } });
    expect(await screen.findByText("No schedule here matches that.")).toBeTruthy();
    // Not the empty-state paragraph: telling a user with two schedules that they have none is worse
    // than telling them their search found nothing.
    expect(screen.queryByText(/Nothing is scheduled here yet/)).toBeNull();
    expect(document.querySelectorAll(".sched-row")).toHaveLength(0);
  });

  it("hides the whole filter bar on a page with nothing to filter", async () => {
    await mount([]);
    expect(screen.queryByLabelText("Search schedules")).toBeNull();
    expect(screen.getByText(/Nothing is scheduled here yet/)).toBeTruthy();
  });

  it("narrows the list to the chip that was clicked", async () => {
    await mount([active, paused, done]);
    expect(document.querySelectorAll(".sched-row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
    expect(document.querySelectorAll(".sched-row")).toHaveLength(1);
    expect(screen.getByText("Weekly digest")).toBeTruthy();
  });
});

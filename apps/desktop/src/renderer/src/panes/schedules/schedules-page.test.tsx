import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parseOnce, sessionEvent, type Run, type Schedule, type StoredSessionEvent } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, runRow, session, type FakeData } from "../../state/store.test-fakes";
import { SchedulesPage } from "./SchedulesPage";
/* The overlay draws its page through the registry, which the panes fill by side effect. */
import "../index";
import { PageNavProvider } from "../../components/page-nav";
import { PageOverlay } from "../../components/PageOverlay";
import { Sidebar } from "../../components/sidebar/Sidebar";

afterEach(() => cleanup());

/** Held on a Monday at noon, so every relative day below reads the same whenever this runs. Only
 *  `Date` is faked — the timers `waitFor` relies on stay real. */
const NOW = new Date(2026, 8, 7, 12);
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

const DAY = 86_400_000;
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sch1", spaceId: "s1", title: "Morning triage", goal: "Read the new issues and group them by area.",
  cron: "0 9 * * *", enabled: true, constraints: { agentKind: "fake" },
  nextRunAt: new Date(2026, 8, 8, 9).getTime(), lastRunAt: null, lastRunId: null, lastSkippedAt: null,
  newSessionPerRun: true, archiveSucceeded: false, createdAt: 1, updatedAt: 1, ...over,
});
const stored = (sessionId: string, seq: number, event: StoredSessionEvent["event"]): StoredSessionEvent => ({ seq, sessionId, event });

async function mount(data: FakeData = {}) {
  const api = fakeApi(data);
  const store = createAppStore(api);
  await store.getState().boot();
  render(
    <StoreContext.Provider value={store}>
      <SchedulesPage item={item("page", "s1", { kind: "schedules-page", refId: "00000000000000000000000006", title: "Scheduled tasks" })} visible focused />
    </StoreContext.Provider>,
  );
  await waitFor(() => expect(api.calls).toContain("listSchedules:s2"));
  return { api, store };
}

const column = () => screen.getByRole("navigation", { name: "Scheduled tasks" });
const task = (name: string) => within(column()).getByRole("button", { name: new RegExp(`^${name}`) });

describe("the Scheduled page", () => {
  it("opens on the place to start a task, with the tasks in its own column", async () => {
    await mount({ schedules: [schedule()] });
    expect(screen.getByRole("heading", { name: "Schedule a task" })).toBeInTheDocument();
    expect(within(column()).getByRole("heading", { name: "Scheduled" })).toBeInTheDocument();
    // The task's second line: when it runs next, then how often.
    expect(within(column()).getByText("Tomorrow 9:00 AM · Daily")).toBeInTheDocument();
  });

  it("lists every task the profile has, whichever space it runs in, soonest first", async () => {
    // THE MUTANT: list the vantage space alone. A task moved to another space through the modal would
    // vanish from the page it was just edited on.
    await mount({ schedules: [
      schedule({ id: "a", title: "Later", nextRunAt: new Date(2026, 8, 9, 9).getTime() }),
      schedule({ id: "b", title: "Sooner", spaceId: "s2", nextRunAt: new Date(2026, 8, 7, 18).getTime() }),
      schedule({ id: "c", title: "Paused", enabled: false, nextRunAt: null }),
    ] });
    await waitFor(() => expect(within(column()).getAllByRole("listitem").length).toBeGreaterThan(2));
    const names = [...column().querySelectorAll(".sched-task-name")].map((n) => n.textContent);
    expect(names).toEqual(["Sooner", "Later", "Paused"]);
    expect(within(column()).getByText("Paused · Daily")).toBeInTheDocument();
  });

  it("searches what a task does, not only what it is called", async () => {
    await mount({ schedules: [schedule(), schedule({ id: "b", title: "Digest", goal: "Summarise the week." })] });
    fireEvent.click(within(column()).getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "issues" } });
    expect(column().querySelectorAll(".sched-task")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "zzz" } });
    expect(within(column()).getByText("No task matches that.")).toBeInTheDocument();
  });
});

describe("a task's runs", () => {
  const GOAL = "Read the new issues and group them by area.";
  const ran = (id: string, at: number, extra: Partial<Run> = {}) =>
    runRow(id, "s1", { scheduleId: "sch1", state: "succeeded", createdAt: at, startedAt: at, sessionId: `se-${id}`, ...extra });
  const seed = (unreadSeen: number): FakeData => ({
    schedules: [schedule({ lastRunAt: NOW.getTime() - DAY, lastRunId: "r1" })],
    runs: { s1: [ran("r1", NOW.getTime() - DAY)] },
    sessions: [session("se-r1", "s1", { lastEventSeq: 2, seenSeq: unreadSeen, dispatchedBy: { sessionId: null, kind: "run" } })],
    sessionEvents: { "se-r1": [
      stored("se-r1", 1, sessionEvent("user_message", { text: GOAL, attachments: [] })),
      stored("se-r1", 2, sessionEvent("assistant_text", { messageId: "m1", text: "Grouped twelve issues into four areas." })),
    ] },
  });

  it("marks a task whose run nobody has read, and opening the run reads it", async () => {
    // THE MUTANT: the sidebar's `isUnread`, which treats a session never opened as caught up — every
    // run a clock starts is one, so the mark would never appear at all.
    const { api } = await mount(seed(0));
    await waitFor(() => expect(within(task("Morning triage")).getByLabelText("1 unread")).toBeInTheDocument());
    fireEvent.click(task("Morning triage"));
    // The task opens on its latest run: the run's own session, its first message the instructions.
    await waitFor(() => expect(screen.getByText("Grouped twelve issues into four areas.")).toBeInTheDocument());
    expect(screen.getAllByText(GOAL).length).toBeGreaterThan(0);
    await waitFor(() => expect(api.calls).toContain("markSessionSeen:se-r1@2"));
    await waitFor(() => expect(within(column()).queryByLabelText(/unread/i)).toBeNull());
  });

  it("puts the task's card beside the run: what it is told, when, and on what model", async () => {
    await mount(seed(2));
    fireEvent.click(task("Morning triage"));
    const card = await screen.findByRole("complementary", { name: "Morning triage details" });
    expect(within(card).getByText("Every day at 9:00 AM")).toBeInTheDocument();
    expect(within(card).getByText(GOAL)).toBeInTheDocument();
    expect(within(card).getByText("Fake agent · Fake")).toBeInTheDocument();
    expect(within(card).getByText(/^0 outputs$/)).toBeInTheDocument();
  });

  it("lists three runs under an open task, and the rest behind Show older", async () => {
    const runs = [0, 1, 2, 3, 4].map((i) => ran(`r${i}`, NOW.getTime() - (i + 1) * DAY));
    await mount({ schedules: [schedule()], runs: { s1: runs } });
    fireEvent.click(task("Morning triage"));
    const list = await screen.findByRole("list", { name: "Runs of Morning triage" });
    await waitFor(() => expect(within(list).getAllByRole("button").filter((b) => b.classList.contains("sched-run"))).toHaveLength(3));
    fireEvent.click(within(list).getByRole("button", { name: "Show older" }));
    await waitFor(() => expect([...list.querySelectorAll(".sched-run")]).toHaveLength(5));
  });
});

describe("the Schedule a task modal", () => {
  const open = async () => {
    fireEvent.click(within(column()).getByRole("button", { name: "New task" }));
    return screen.findByRole("dialog", { name: "Schedule a task" });
  };

  it("keeps Create off until the task has a name, instructions and a first run", async () => {
    await mount();
    const dialog = await open();
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Task name"), { target: { value: "Nightly" } });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Instructions"), { target: { value: "Sweep the inbox." } });
    expect(create).toBeEnabled();
    expect(within(dialog).getByText("First run tomorrow at 9:00 am.")).toBeInTheDocument();
    // A hand-written expression that never fires says so and turns the button back off.
    fireEvent.change(within(dialog).getByLabelText("Repeat"), { target: { value: "custom" } });
    fireEvent.change(within(dialog).getByLabelText("Cron expression"), { target: { value: "0 9 30 2 *" } });
    expect(within(dialog).getByText(/will never run/)).toBeInTheDocument();
    expect(create).toBeDisabled();
  });

  it("creates exactly what the menus say, instructions verbatim, and lands on the new task", async () => {
    const { store } = await mount();
    const dialog = await open();
    // Ends in a newline on purpose: an instruction is sent as typed, and a trim would be a rewrite.
    const goal = "Plan the release, then have GPT-6 Luna implement it with sub-agents.\n\n  Keep notes in docs/release.md.\n";
    fireEvent.change(within(dialog).getByLabelText("Task name"), { target: { value: "  Release prep  " } });
    fireEvent.change(within(dialog).getByLabelText("Instructions"), { target: { value: goal } });
    fireEvent.change(within(dialog).getByLabelText("Repeat"), { target: { value: "weekly" } });
    fireEvent.change(within(dialog).getByLabelText("Day"), { target: { value: "5" } });
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "16:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Advanced" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Start each run in a new session" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Archive successful runs" }));
    fireEvent.change(within(dialog).getByLabelText("Space"), { target: { value: "s2" } });
    // Offered once the agents have answered their probe, as the prompter's picker is.
    await within(dialog).findByRole("option", { name: "Fake" });
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "fake|fake" } });
    fireEvent.change(within(dialog).getByLabelText("Effort"), { target: { value: "high" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(store.getState().schedules.s2).toHaveLength(1));
    expect(store.getState().schedules.s2![0]).toMatchObject({
      title: "Release prep", goal, cron: "0 16 * * 5", newSessionPerRun: false, archiveSucceeded: true,
      constraints: { agentKind: "fake", model: "fake", effort: "high" },
    });
    // The modal is gone and the page is on the task it made, which has not run yet.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("heading", { name: "No runs yet" })).toBeInTheDocument();
  });

  it("schedules a single run when Repeat task is off", async () => {
    const { store } = await mount();
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("Task name"), { target: { value: "Ship it" } });
    fireEvent.change(within(dialog).getByLabelText("Instructions"), { target: { value: "Open the PR." } });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Repeat task" }));
    expect(within(dialog).queryByLabelText("Repeat")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2026-09-30" } });
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "13:00" } });
    expect(within(dialog).getByText(/^Runs once, /)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(store.getState().schedules.s1).toHaveLength(1));
    expect(parseOnce(store.getState().schedules.s1![0]!.cron)).toBe(new Date(2026, 8, 30, 13).getTime());
  });

  it("opens a suggestion with its instructions already written", async () => {
    await mount();
    fireEvent.click(within(column()).getByRole("button", { name: /^Weekly review/ }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule a task" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Task name").value).toBe("Weekly review");
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>("Instructions").value).toContain("agent_peers");
    expect(within(dialog).getByLabelText<HTMLSelectElement>("Repeat").value).toBe("weekly");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
  });
});

describe("the task's card", () => {
  it("edits the task in the same modal, opened on what the task holds", async () => {
    const { api, store } = await mount({ schedules: [schedule({ cron: "1 8 * * 2" })] });
    fireEvent.click(task("Morning triage"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Morning triage" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit task" });
    // 8:01 is off the menu's half-hour grid, and it opens as 8:01 rather than as the nearest step.
    expect(within(dialog).getByLabelText<HTMLSelectElement>("Time").value).toBe("08:01");
    expect(within(dialog).getByLabelText<HTMLSelectElement>("Repeat").value).toBe("weekly");
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "09:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls).toContain("updateSchedule:sch1"));
    await waitFor(() => expect(store.getState().schedules.s1![0]!.cron).toBe("30 9 * * 2"));
  });

  it("runs the task now through the method that leaves its clock alone, and opens the run it made", async () => {
    const { api } = await mount({ schedules: [schedule()] });
    fireEvent.click(task("Morning triage"));
    fireEvent.click(await screen.findByRole("button", { name: "More for Morning triage" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(api.calls).toContain("runScheduleNow:sch1"));
    // The run is listed under its task and open beside its card — still starting, here.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Starting…" })).toBeInTheDocument());
    expect(within(screen.getByRole("list", { name: "Runs of Morning triage" })).getByText("Starting")).toBeInTheDocument();
  });

  it("names a run that was missed, instead of letting the last one stand in for it", async () => {
    await mount({ schedules: [schedule({ lastRunAt: NOW.getTime() - 8 * DAY, lastSkippedAt: NOW.getTime() - DAY })] });
    fireEvent.click(task("Morning triage"));
    const card = await screen.findByRole("complementary", { name: "Morning triage details" });
    expect(within(card).getByText(/^Missed a run yesterday 12:00 PM$/)).toBeInTheDocument();
  });
});

describe("the column, in the sidebar's place", () => {
  /** The page as the window shows it: over the panes, beside the real sidebar, whose column a page's
   *  sections can take (components/page-nav.tsx). */
  async function mountInWindow(data: FakeData = {}) {
    const api = fakeApi(data);
    const store = createAppStore(api);
    await store.getState().boot();
    render(
      <StoreContext.Provider value={store}>
        <PageNavProvider>
          <Sidebar collapsed={store.getState().sidebarCollapsed} />
          <PageOverlay />
        </PageNavProvider>
      </StoreContext.Provider>,
    );
    act(() => store.getState().openDestinationPage("schedules-page"));
    return { api, store };
  }
  const sidebar = () => document.getElementById("app-sidebar")!;
  const page = () => document.querySelector<HTMLElement>(".page-overlay")!;

  it("is the sidebar's column, the spaces hidden and no Back over it, and none of it in the page", async () => {
    /* The owner, 10-05: "The sidebar for scheduled tasks needs to be the same as the home sidebar and
       the library sidebar. It currently looks darker, there is no corner rounding … It is supposed to be
       the replacement sidebar". And later that day, of its Back: "unnecessary" — the rail opened the
       page, and its lit button and Home put it away. THE MUTANTS: the column left in the page (a
       second, darker sidebar), drawn in the sidebar beside the spaces rather than in their place, or
       under a Back again. */
    const { api } = await mountInWindow({ schedules: [schedule()] });
    const col = within(sidebar()).getByRole("navigation", { name: "Scheduled tasks" });
    expect(col.closest(".sb-page-nav")).not.toBeNull();
    expect(within(sidebar()).queryByRole("button", { name: "Back" })).toBeNull();
    expect(sidebar().querySelector(".sb-list")).toHaveAttribute("hidden");
    expect(page().querySelector(".sched-col")).toBeNull();
    // Still the page's own column: its tasks, and New task opening the page's modal.
    await waitFor(() => expect(api.calls).toContain("listSchedules:s1"));
    expect(await within(col).findByRole("button", { name: /^Morning triage/ })).toBeInTheDocument();
    fireEvent.click(within(col).getByRole("button", { name: "New task" }));
    expect(await screen.findByRole("dialog", { name: "Schedule a task" })).toBeInTheDocument();
  });

  it("stands in the page while the sidebar is folded away, where it can still be reached", async () => {
    // THE MUTANT: a column portalled into a sidebar that is off the window and inert.
    await mountInWindow({ settings: { "ui.sidebarCollapsed": true } });
    expect(within(page()).getByRole("navigation", { name: "Scheduled tasks" })).toBeInTheDocument();
    expect(sidebar().querySelector(".sb-page")).toBeNull();
  });
});

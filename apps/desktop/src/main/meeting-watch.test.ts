import { describe, expect, it } from "vitest";
import { MeetingWatch, parseCalendarLine, parseMicrophoneLine, type HelperProcess } from "./meeting-watch";
import { CALL_END_MS, CALL_START_MS, MEETING_LATE_MS, MEETING_SOON_MS, type CallApp, type Meeting } from "./meeting-rules";

const MIN = 60_000;
const NOON = Date.UTC(2026, 10, 20, 20, 0, 0);
const LINK = "https://meet.google.com/abc-defg-hij";

/** The helper's events line: one meeting at noon, with whatever is said about it. */
const eventsLine = (event: Record<string, unknown> = {}) => JSON.stringify({
  events: [event].map((e) => ({ id: "E1", title: "Design review", start: NOON, end: NOON + 30 * MIN, allDay: false, cancelled: false, participation: "accepted", url: "", location: LINK, notes: "", ...e })),
});

/** The service on a clock the test moves, with helpers that are only their lines. */
function watch(over: { said?: string[]; noHelper?: boolean } = {}) {
  let now = NOON - 10 * MIN;
  const timers = new Set<{ time: number; run: () => void }>();
  const helpers: Record<string, { onLine: (line: string) => void; sent: string[]; running: boolean }[]> = { calendar: [], calls: [] };
  const seen = {
    opened: [] as string[], notified: [] as { title: string; click: () => void }[], saved: [] as string[][],
    access: [] as (string | null)[], events: [] as string[],
  };
  const service = new MeetingWatch({
    startHelper: (mode, onLine) => {
      if (over.noHelper) return null;
      const helper = { onLine, sent: [] as string[], running: true };
      helpers[mode]!.push(helper);
      const process: HelperProcess = { send: (command) => helper.sent.push(command), stop: () => { helper.running = false; } };
      return process;
    },
    now: () => now,
    at: (time, run) => {
      const timer = { time, run };
      timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    },
    openLink: (link) => seen.opened.push(link),
    notify: (meeting, click) => seen.notified.push({ title: meeting.title, click }),
    loadSaid: () => over.said ?? [],
    saveSaid: (keys) => seen.saved.push(keys),
    onCalendarAccess: (access) => seen.access.push(access),
    ownBundleId: () => "co.charmtechnologies.realm",
  });
  service.on("meetingSoon", (m: Meeting) => seen.events.push(`soon:${m.title}`));
  service.on("meetingStarted", (m: Meeting) => seen.events.push(`started:${m.title}`));
  service.on("callStarted", (app: CallApp) => seen.events.push(`callStarted:${app.name}`));
  service.on("callEnded", (app: CallApp) => seen.events.push(`callEnded:${app.name}`));
  return {
    service, seen, helpers,
    calendar: () => helpers.calendar!.at(-1)!,
    microphone: () => helpers.calls!.at(-1)!,
    /** Move the clock, running each timer as its time comes. */
    goTo(time: number) {
      for (;;) {
        const next = [...timers].filter((t) => t.time <= time).sort((a, b) => a.time - b.time)[0];
        if (!next) break;
        timers.delete(next);
        now = Math.max(now, next.time);
        next.run();
      }
      now = time;
    },
    /** The Mac slept: the clock moves and no timer runs until it wakes. */
    sleepUntil(time: number) { now = time; },
    timers,
  };
}

describe("the helper's lines", () => {
  it("reads calendar access and events, and nothing else", () => {
    expect(parseCalendarLine('{"access":"notDetermined"}')).toEqual({ access: "notDetermined" });
    expect(parseCalendarLine(eventsLine())).toEqual({ events: [expect.objectContaining({ id: "E1", start: NOON, location: LINK, participation: "accepted" })] });
    expect(parseCalendarLine('{"events":[]}')).toEqual({ events: [] });
    for (const bad of ['{"access":"yes"}', '{"events":[{"id":1,"start":0,"end":0}]}', '{"events":[{"id":"E","start":"now","end":0}]}', '{"events":{}}', "{}", "not json", ""]) {
      expect(parseCalendarLine(bad), bad).toBeNull();
    }
  });

  it("reads who holds the microphone and which apps have a call's title, and nothing else", () => {
    expect(parseMicrophoneLine('{"holders":["us.zoom.xos"],"titled":[{"app":"com.google.Chrome","service":"Google Meet"}]}'))
      .toEqual({ holders: ["us.zoom.xos"], titled: [{ app: "com.google.Chrome", service: "Google Meet" }] });
    for (const bad of ['{"holders":[1],"titled":[]}', '{"holders":[]}', '{"holders":[],"titled":[{"app":"x"}]}', "{}", ""]) {
      expect(parseMicrophoneLine(bad), bad).toBeNull();
    }
  });
});

describe("opening a meeting when it starts", () => {
  function withMeeting(over: Parameters<typeof watch>[0] = {}) {
    const w = watch(over);
    w.service.setOpensMeetings(true);
    w.calendar().onLine('{"access":"full"}');
    w.calendar().onLine(eventsLine());
    return w;
  }

  it("notifies two minutes before and opens the link at the start, each once", () => {
    const w = withMeeting();
    w.goTo(NOON - MEETING_SOON_MS - 1);
    expect(w.seen.notified).toEqual([]);
    w.goTo(NOON - MEETING_SOON_MS);
    expect(w.seen.notified.map((n) => n.title)).toEqual(["Design review"]);
    expect(w.seen.opened).toEqual([]);
    w.goTo(NOON);
    expect(w.seen.opened).toEqual([LINK]);
    // The helper prints the events again whenever the store changes.
    w.calendar().onLine(eventsLine({ notes: "edited" }));
    w.goTo(NOON + 20 * MIN);
    expect(w.seen.notified).toHaveLength(1);
    expect(w.seen.opened).toEqual([LINK]);
    expect(w.seen.events).toEqual(["soon:Design review", "started:Design review"]);
  });

  it("opens from a click on the notification, and then not again at the start", () => {
    const w = withMeeting();
    w.goTo(NOON - MIN);
    w.seen.notified[0]!.click();
    w.seen.notified[0]!.click();
    expect(w.seen.opened).toEqual([LINK]);
    w.goTo(NOON + MIN);
    expect(w.seen.opened).toEqual([LINK]);
    // The start is still said: the assistant will want it whichever way the link was opened.
    expect(w.seen.events).toContain("started:Design review");
  });

  it("says nothing twice after a relaunch", () => {
    const first = withMeeting();
    first.goTo(NOON - MIN);
    const relaunched = withMeeting({ said: first.seen.saved.at(-1) });
    relaunched.goTo(NOON - MIN + 1000);
    expect(relaunched.seen.notified).toEqual([]);
    relaunched.goTo(NOON);
    expect(relaunched.seen.opened).toEqual([LINK]);
    const again = withMeeting({ said: relaunched.seen.saved.at(-1) });
    again.goTo(NOON + MIN);
    expect(again.seen.opened).toEqual([]);
    expect(again.seen.events).toEqual([]);
  });

  it("opens a meeting the Mac slept into when it wakes within five minutes of the start", () => {
    const w = withMeeting();
    w.sleepUntil(NOON + MEETING_LATE_MS);
    w.service.wake();
    expect(w.seen.opened).toEqual([LINK]);
    expect(w.seen.notified).toEqual([]);
  });

  it("opens nothing when the Mac wakes later than that, and nothing afterwards either", () => {
    const w = withMeeting();
    w.sleepUntil(NOON + MEETING_LATE_MS + 1);
    w.service.wake();
    w.goTo(NOON + 20 * MIN);
    expect(w.seen.opened).toEqual([]);
    expect(w.seen.notified).toEqual([]);
    expect(w.seen.events).toEqual([]);
  });

  it("takes a moved meeting as a new occurrence", () => {
    const w = withMeeting();
    w.goTo(NOON);
    w.calendar().onLine(eventsLine({ start: NOON + 60 * MIN, end: NOON + 90 * MIN }));
    w.goTo(NOON + 60 * MIN);
    expect(w.seen.opened).toEqual([LINK, LINK]);
  });

  it("forgets what it said about meetings more than a day old, so the file does not grow for ever", () => {
    const w = withMeeting({ said: [`OLD@${NOON - 3 * 24 * 60 * MIN}|started`, `E0@${NOON - MIN}|started`] });
    w.goTo(NOON);
    expect(w.seen.saved.at(-1)).not.toContain(`OLD@${NOON - 3 * 24 * 60 * MIN}|started`);
    expect(w.seen.saved.at(-1)).toContain(`E0@${NOON - MIN}|started`);
  });

  it("does nothing until calendar access is granted, and says what the access is", () => {
    const w = watch();
    w.service.setOpensMeetings(true);
    w.calendar().onLine('{"access":"notDetermined"}');
    w.goTo(NOON + MIN);
    expect(w.service.access).toBe("notDetermined");
    expect(w.seen.access).toEqual(["notDetermined"]);
    expect([w.seen.notified, w.seen.opened, w.seen.events]).toEqual([[], [], []]);
  });

  it("asks macOS only when told to, by the one command", () => {
    const w = watch();
    w.service.setOpensMeetings(true);
    w.calendar().onLine('{"access":"notDetermined"}');
    w.service.checkCalendar();
    expect(w.calendar().sent).toEqual(["check"]);
    w.service.askForCalendar();
    expect(w.calendar().sent).toEqual(["check", "ask"]);
  });

  it("drops its meetings when access is taken away", () => {
    const w = withMeeting();
    w.calendar().onLine('{"access":"denied"}');
    w.goTo(NOON + MIN);
    expect([w.seen.notified, w.seen.opened]).toEqual([[], []]);
  });

  it("reads no calendar with the setting off: no helper, and one that was running is stopped", () => {
    const w = watch();
    w.service.setOpensMeetings(false);
    expect(w.helpers.calendar).toEqual([]);
    w.service.setOpensMeetings(true);
    w.service.setOpensMeetings(true);
    expect(w.helpers.calendar).toHaveLength(1);
    w.calendar().onLine('{"access":"full"}');
    w.calendar().onLine(eventsLine());
    w.service.setOpensMeetings(false);
    expect(w.calendar().running).toBe(false);
    expect(w.service.access).toBeNull();
    expect(w.timers.size).toBe(0);
    // A line the stopped helper had already written changes nothing.
    w.calendar().onLine(eventsLine());
    w.calendar().onLine('{"access":"denied"}');
    expect(w.service.access).toBeNull();
    w.goTo(NOON + MIN);
    expect([w.seen.notified, w.seen.opened, w.seen.events]).toEqual([[], [], []]);
    expect(w.timers.size).toBe(0);
  });

  it("is quiet where there is no helper", () => {
    const w = watch({ noHelper: true });
    w.service.setOpensMeetings(true);
    w.service.askForCalendar();
    w.service.watchCalls(true);
    w.service.stop();
    expect(w.service.access).toBeNull();
  });
});

describe("calls", () => {
  const holders = (...ids: string[]) => JSON.stringify({ holders: ids, titled: [] });

  it("starts no helper until something wants calls, and stops it after", () => {
    const w = watch();
    expect(w.helpers.calls).toEqual([]);
    w.service.watchCalls(true);
    expect(w.microphone().running).toBe(true);
    w.service.watchCalls(false);
    expect(w.microphone().running).toBe(false);
  });

  it("says a call started after the wait and ended after the wait, by its own timers", () => {
    const w = watch();
    const t0 = NOON - 10 * MIN;
    w.service.watchCalls(true);
    w.microphone().onLine(holders("us.zoom.xos"));
    w.goTo(t0 + CALL_START_MS - 1);
    expect(w.seen.events).toEqual([]);
    w.goTo(t0 + CALL_START_MS);
    expect(w.seen.events).toEqual(["callStarted:Zoom"]);
    w.goTo(t0 + 60_000);
    w.microphone().onLine(holders());
    w.goTo(t0 + 60_000 + CALL_END_MS - 1);
    expect(w.seen.events).toEqual(["callStarted:Zoom"]);
    w.goTo(t0 + 60_000 + CALL_END_MS);
    expect(w.seen.events).toEqual(["callStarted:Zoom", "callEnded:Zoom"]);
  });

  it("says nothing for a hold shorter than the wait", () => {
    const w = watch();
    const t0 = NOON - 10 * MIN;
    w.service.watchCalls(true);
    w.microphone().onLine(holders("us.zoom.xos"));
    w.goTo(t0 + 1500);
    w.microphone().onLine(holders());
    w.goTo(t0 + 60_000);
    expect(w.seen.events).toEqual([]);
  });

  it("starts a browser's call when a meeting's window opens on a browser already holding the microphone", () => {
    const w = watch();
    w.service.setOpensMeetings(true);
    w.calendar().onLine('{"access":"full"}');
    w.calendar().onLine(eventsLine());
    w.service.watchCalls(true);
    w.microphone().onLine(holders("com.google.Chrome.helper"));
    w.goTo(NOON - 5 * MIN - 1);
    expect(w.seen.events).toEqual([]);
    w.goTo(NOON - 5 * MIN + CALL_START_MS);
    expect(w.seen.events).toEqual(["callStarted:Google Chrome"]);
  });

  it("stops everything on quit", () => {
    const w = watch();
    w.service.setOpensMeetings(true);
    w.service.watchCalls(true);
    w.service.stop();
    expect([w.calendar().running, w.microphone().running]).toEqual([false, false]);
  });
});

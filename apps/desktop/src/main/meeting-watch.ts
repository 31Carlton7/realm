import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isCalendarAccess, type CalendarAccess } from "@realm/contracts";
import {
  CallTracker, browserWindowOpens, meetingsDue, meetingsOf, microphoneApps, soonKey, startedKey,
  type CalendarEvent, type CallApp, type Meeting, type MicrophoneLine,
} from "./meeting-rules";

export function meetingWatchPath(appPath: string, resourcesPath: string): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.REALM_MEETINGWATCH_BIN) return process.env.REALM_MEETINGWATCH_BIN;
  const dev = join(appPath, "native", "bin", "meetingwatch");
  if (existsSync(dev)) return dev;
  const packaged = join(resourcesPath, "meetingwatch");
  return existsSync(packaged) ? packaged : null;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** One line of the helper's calendar mode (native/MeetingWatch.swift), or null for one that is not. */
export function parseCalendarLine(line: string): { access: CalendarAccess } | { events: CalendarEvent[] } | null {
  try {
    const v = JSON.parse(line) as { access?: unknown; events?: unknown };
    if (isCalendarAccess(v.access)) return { access: v.access };
    if (!Array.isArray(v.events)) return null;
    const events: CalendarEvent[] = [];
    for (const e of v.events as Record<string, unknown>[]) {
      if (typeof e?.id !== "string" || !Number.isFinite(e.start) || !Number.isFinite(e.end)) return null;
      events.push({
        id: e.id, title: text(e.title), start: e.start as number, end: e.end as number, allDay: e.allDay === true,
        cancelled: e.cancelled === true, participation: text(e.participation),
        url: text(e.url), location: text(e.location), notes: text(e.notes),
      });
    }
    return { events };
  } catch {
    return null;
  }
}

/** One line of the helper's calls mode, or null for one that is not. */
export function parseMicrophoneLine(line: string): MicrophoneLine | null {
  try {
    const v = JSON.parse(line) as { holders?: unknown; titled?: unknown };
    if (!Array.isArray(v.holders) || !v.holders.every((h) => typeof h === "string") || !Array.isArray(v.titled)) return null;
    const titled: MicrophoneLine["titled"] = [];
    for (const t of v.titled as { app?: unknown; service?: unknown }[]) {
      if (typeof t?.app !== "string" || typeof t.service !== "string") return null;
      titled.push({ app: t.app, service: t.service });
    }
    return { holders: v.holders as string[], titled };
  } catch {
    return null;
  }
}

/** A running helper: lines out, commands in, and gone when asked. */
export type HelperProcess = { send(command: string): void; stop(): void };

/** Starts `meetingwatch <mode>`. It quits when its stdin closes, which is also what happens if Realm dies. */
export function startMeetingWatchHelper(bin: string, mode: "calendar" | "calls", onLine: (line: string) => void): HelperProcess {
  const child = spawn(bin, [mode], { stdio: ["pipe", "pipe", "ignore"] });
  child.on("error", (e) => console.warn(`[meetingwatch] ${mode} failed to spawn:`, e.message));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", onLine);
  return {
    send: (command) => { if (child.stdin.writable) child.stdin.write(`${command}\n`); },
    stop: () => child.stdin.end(),
  };
}
type Timer = { cancel(): void };

export type MeetingWatchEvents = {
  /** Two minutes before a meeting's start. */
  meetingSoon: [Meeting];
  meetingStarted: [Meeting];
  /** A calling app has held the microphone for a few seconds, and has let go of it for a few. */
  callStarted: [CallApp];
  callEnded: [CallApp];
};

/**
 * Knows when a meeting or a call starts, and hands that out as four events.
 *
 * Meetings come from the calendar: the helper's calendar mode runs while "Open the meeting when it
 * starts" is on, and with it on a notification goes up two minutes before a meeting and its link is
 * opened at the start. A click on the notification opens the link early, and then the start does not
 * open it again. Each event is said once per occurrence: what was said is kept in a file, so a
 * relaunch says nothing twice, and a Mac that wakes more than five minutes into a meeting opens nothing.
 *
 * Calls come from the microphone: the helper's calls mode runs while `watchCalls` is on.
 */
export class MeetingWatch {
  private readonly events = new EventEmitter();
  private calls = new CallTracker();
  private calendar: HelperProcess | null = null;
  private microphone: HelperProcess | null = null;
  private calendarAccess: CalendarAccess | null = null;
  private meetings: Meeting[] = [];
  private microphoneLine: MicrophoneLine = { holders: [], titled: [] };
  private said: Set<string>;
  private meetingTimer: Timer | null = null;
  private callTimer: Timer | null = null;

  constructor(private readonly d: {
    /** Starts `meetingwatch <mode>`, or answers null where there is no helper. */
    startHelper: (mode: "calendar" | "calls", onLine: (line: string) => void) => HelperProcess | null;
    now: () => number;
    at: (time: number, run: () => void) => Timer;
    openLink: (link: string) => void;
    notify: (meeting: Meeting, onClick: () => void) => void;
    /** The keys already said, kept across a relaunch. */
    loadSaid: () => string[];
    saveSaid: (keys: string[]) => void;
    onCalendarAccess: (access: CalendarAccess | null) => void;
    /** Realm's own bundle id, whose microphone use (dictation) is never a call. */
    ownBundleId: () => string;
  }) {
    this.said = new Set(d.loadSaid());
  }

  on<E extends keyof MeetingWatchEvents>(event: E, listener: (...args: MeetingWatchEvents[E]) => void): void {
    this.events.on(event, listener);
  }

  /** Calendar access as the helper last reported it; null while no helper is running to say. */
  get access(): CalendarAccess | null { return this.calendarAccess; }

  /** Settings ▸ General ▸ Meetings' switch. Off, the calendar is not read at all. */
  setOpensMeetings(on: boolean): void {
    if (on && !this.calendar) {
      this.calendar = this.d.startHelper("calendar", (line) => this.readCalendar(line));
    } else if (!on && this.calendar) {
      this.calendar.stop();
      this.calendar = null;
      this.meetings = [];
      this.meetingTimer?.cancel();
      this.setAccess(null);
    }
  }

  /** Whether anything wants `callStarted` and `callEnded`. Nothing does yet: the assistant will. */
  watchCalls(on: boolean): void {
    if (on && !this.microphone) {
      this.microphone = this.d.startHelper("calls", (line) => {
        const read = parseMicrophoneLine(line);
        if (read) { this.microphoneLine = read; this.lookAtCalls(); }
      });
    } else if (!on && this.microphone) {
      this.microphone.stop();
      this.microphone = null;
      this.callTimer?.cancel();
      this.calls = new CallTracker();
    }
  }

  /** The button in Settings: the one thing that makes macOS ask for the calendar. */
  askForCalendar(): void { this.calendar?.send("ask"); }

  /** Read the access again: a grant changed in System Settings tells nobody. */
  checkCalendar(): void { this.calendar?.send("check"); }

  /** The Mac woke: timers set before it slept are late by however long it slept. */
  wake(): void {
    this.lookAtMeetings();
    this.lookAtCalls();
  }

  stop(): void {
    this.setOpensMeetings(false);
    this.watchCalls(false);
  }

  private setAccess(access: CalendarAccess | null): void {
    if (access === this.calendarAccess) return;
    this.calendarAccess = access;
    this.d.onCalendarAccess(access);
  }

  private readCalendar(line: string): void {
    const read = parseCalendarLine(line);
    if (!read) return;
    if ("access" in read) {
      this.setAccess(read.access);
      if (read.access !== "full") this.meetings = [];
    } else {
      this.meetings = meetingsOf(read.events);
    }
    this.lookAtMeetings();
    this.lookAtCalls();
  }

  private lookAtMeetings(): void {
    this.meetingTimer?.cancel();
    this.meetingTimer = null;
    const now = this.d.now();
    const due = meetingsDue(this.meetings, this.said, now);
    for (const meeting of due.soon) {
      this.say(soonKey(meeting));
      this.events.emit("meetingSoon", meeting);
      this.d.notify(meeting, () => this.open(meeting));
    }
    for (const meeting of due.started) {
      this.say(startedKey(meeting));
      this.events.emit("meetingStarted", meeting);
      this.open(meeting);
    }
    for (const meeting of due.missed) this.say(startedKey(meeting));
    if (due.next !== null) this.meetingTimer = this.d.at(due.next, () => this.lookAtMeetings());
  }

  private open(meeting: Meeting): void {
    const opened = `${meeting.key}|opened`;
    if (this.said.has(opened)) return;
    this.say(opened);
    this.d.openLink(meeting.link);
  }

  private say(key: string): void {
    this.said.add(key);
    // A key carries its meeting's start (`<id>@<start>|soon`); one a day old can never come due again.
    const dayAgo = this.d.now() - 24 * 60 * 60_000;
    for (const k of this.said) if (Number(/@(\d+)\|/.exec(k)?.[1]) < dayAgo) this.said.delete(k);
    this.d.saveSaid([...this.said]);
  }

  private lookAtCalls(): void {
    if (!this.microphone) return;
    this.callTimer?.cancel();
    this.callTimer = null;
    const now = this.d.now();
    const apps = microphoneApps(this.microphoneLine, this.meetings, now, this.d.ownBundleId());
    const read = this.calls.read(apps, now);
    for (const app of read.started) this.events.emit("callStarted", app);
    for (const app of read.ended) this.events.emit("callEnded", app);
    // A browser already holding the microphone becomes a call when a meeting's window opens.
    const waiting = apps.holding.length > apps.mayStart.length ? browserWindowOpens(this.meetings, now) : null;
    const next = [read.next, waiting].filter((t): t is number => t !== null);
    if (next.length > 0) this.callTimer = this.d.at(Math.min(...next), () => this.lookAtCalls());
  }
}

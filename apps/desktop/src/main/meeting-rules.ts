/**
 * What counts as a meeting, and what counts as a call. Pure: `meeting-watch.ts` feeds these the lines
 * of the `meetingwatch` helper (native/MeetingWatch.swift) and a clock.
 */

/** One calendar event, as the helper's calendar mode prints it. Times are ms since 1970. */
export type CalendarEvent = {
  id: string; title: string; start: number; end: number; allDay: boolean; cancelled: boolean;
  /** The user's own answer to the invitation; "none" for an event with no invitation. */
  participation: string;
  url: string; location: string; notes: string;
};

export type Meeting = {
  /** One occurrence: a repeating event keeps its id and changes its start. */
  key: string;
  title: string; start: number; end: number; service: string; link: string;
};

/** What the helper's calls mode prints: who holds the microphone, and which apps have a window whose
 *  title names a call. */
export type MicrophoneLine = { holders: string[]; titled: { app: string; service: string }[] };

export type CallApp = { id: string; name: string };

/** The notification comes this long before a meeting's start. */
export const MEETING_SOON_MS = 2 * 60_000;
/** A meeting that began longer ago than this is not opened: a Mac that slept through its start, or a
 *  Realm opened halfway through it, does not throw a call's page up. */
export const MEETING_LATE_MS = 5 * 60_000;
/** A browser holding the microphone counts as a call from this long before a meeting's start. */
export const BROWSER_LEAD_MS = 5 * 60_000;
/**
 * An app is in a call once it has held the microphone this long without a break, and out of it once
 * it has let go this long. Measured against a stand-in process on macOS 27.3: an input opened for
 * 1.5 s, as a permission preview is, starts nothing, and an input closed and opened again within the
 * second, as a device switch is, ends nothing. No calling app's own mute or device switch was timed.
 */
export const CALL_START_MS = 3_000;
export const CALL_END_MS = 5_000;

const LINK_END = String.raw`[^\s<>"']*`;
const MEETING_LINKS: readonly { service: string; pattern: RegExp }[] = [
  { service: "Zoom", pattern: new RegExp(String.raw`https://(?:[\w-]+\.)*zoom(?:gov)?\.(?:us|com)/(?:j|my|s|w|wc)/${LINK_END}`, "i") },
  { service: "Google Meet", pattern: new RegExp(String.raw`https://meet\.google\.com/[a-z]${LINK_END}`, "i") },
  { service: "Microsoft Teams", pattern: new RegExp(String.raw`https://teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/${LINK_END}`, "i") },
  { service: "Webex", pattern: new RegExp(String.raw`https://(?:[\w-]+\.)+webex\.com/${LINK_END}`, "i") },
  { service: "FaceTime", pattern: new RegExp(String.raw`https://facetime\.apple\.com/join${LINK_END}`, "i") },
];

/** The first meeting link in `text`, less the punctuation a sentence leaves after it. */
function linkIn(text: string): { service: string; link: string } | null {
  for (const { service, pattern } of MEETING_LINKS) {
    const found = pattern.exec(text);
    if (found) return { service, link: found[0].replace(/[.,;)\]]+$/, "") };
  }
  return null;
}

/** An event's meeting link: its URL first, then its location, then its notes. */
export function meetingLink(event: Pick<CalendarEvent, "url" | "location" | "notes">): { service: string; link: string } | null {
  return linkIn(event.url) ?? linkIn(event.location) ?? linkIn(event.notes);
}

/** The events that are meetings: a link to a calling service, not all-day, not declined, not cancelled. */
export function meetingsOf(events: readonly CalendarEvent[]): Meeting[] {
  const meetings: Meeting[] = [];
  for (const event of events) {
    if (event.allDay || event.cancelled || event.participation === "declined") continue;
    const found = meetingLink(event);
    if (found) meetings.push({ key: `${event.id}@${event.start}`, title: event.title, start: event.start, end: event.end, ...found });
  }
  return meetings;
}

export type MeetingsDue = {
  /** Within two minutes of starting, and not said yet. */
  soon: Meeting[];
  /** Started within the last five minutes, and not said yet. One that started longer ago is left alone. */
  started: Meeting[];
  /** When to look again, or null with nothing ahead. */
  next: number | null;
};

export const soonKey = (m: Meeting) => `${m.key}|soon`;
export const startedKey = (m: Meeting) => `${m.key}|started`;

/** What is owed at `now`, given the keys already said (`soonKey`, `startedKey`). */
export function meetingsDue(meetings: readonly Meeting[], said: ReadonlySet<string>, now: number): MeetingsDue {
  const due: MeetingsDue = { soon: [], started: [], next: null };
  const lookAt = (time: number) => { if (due.next === null || time < due.next) due.next = time; };
  for (const meeting of meetings) {
    if (now >= meeting.start) {
      if (!said.has(startedKey(meeting)) && now - meeting.start <= MEETING_LATE_MS) due.started.push(meeting);
      continue;
    }
    lookAt(meeting.start);
    if (said.has(soonKey(meeting))) continue;
    if (now >= meeting.start - MEETING_SOON_MS) due.soon.push(meeting);
    else lookAt(meeting.start - MEETING_SOON_MS);
  }
  return due;
}

/** Calling apps, by bundle id. An allow-list: a dictation tool holding the microphone is no call. */
const CALLING_APPS: readonly CallApp[] = [
  { id: "us.zoom.xos", name: "Zoom" },
  { id: "com.microsoft.teams2", name: "Microsoft Teams" },
  { id: "com.microsoft.teams", name: "Microsoft Teams" },
  { id: "com.apple.FaceTime", name: "FaceTime" },
  { id: "com.tinyspeck.slackmacgap", name: "Slack" },
  { id: "com.hnc.Discord", name: "Discord" },
  { id: "Cisco-Systems.Spark", name: "Webex" },
  { id: "com.webex.meetingmanager", name: "Webex" },
];

/** A browser holds the microphone through a helper process (`com.google.Chrome.helper`), named under
 *  the browser's own bundle id. */
const BROWSERS: readonly CallApp[] = [
  { id: "com.google.Chrome", name: "Google Chrome" },
  { id: "company.thebrowser.Browser", name: "Arc" },
  { id: "com.brave.Browser", name: "Brave" },
  { id: "com.microsoft.edgemac", name: "Microsoft Edge" },
];

/** Safari captures in a process any app with a web view also uses, so it says nothing by itself. */
const SAFARI: CallApp = { id: "com.apple.Safari", name: "Safari" };
const WEBKIT_CAPTURE = "com.apple.WebKit.GPU";

/** Whether `bundle` is the app `id` or one of its helper processes. */
const belongsTo = (bundle: string, id: string) => bundle === id || bundle.startsWith(`${id}.`);

export type MicrophoneApps = {
  /** Every calling app and browser holding the microphone. */
  holding: CallApp[];
  /** Those of them that may start a call now. A browser may only inside a meeting's window (five
   *  minutes before its start to its end) or with a window whose title names a call, since a browser
   *  uses the microphone for other things too; Safari only inside a meeting's window. */
  mayStart: CallApp[];
};

/** `own` is Realm's bundle id: its dictation holds the microphone, and that is never a call. */
export function microphoneApps(line: MicrophoneLine, meetings: readonly Meeting[], now: number, own: string): MicrophoneApps {
  const holders = line.holders.filter((bundle) => !belongsTo(bundle, own));
  const held = (app: CallApp) => holders.some((bundle) => belongsTo(bundle, app.id));
  const inMeeting = meetings.some((m) => now >= m.start - BROWSER_LEAD_MS && now <= m.end);
  const calling = CALLING_APPS.filter(held);
  const browsers = BROWSERS.filter(held);
  const safari = holders.includes(WEBKIT_CAPTURE) ? [SAFARI] : [];
  const titled = (browser: CallApp) => line.titled.some((t) => belongsTo(t.app, browser.id));
  // Teams is listed under both of its bundle ids, and one call is one app.
  const once = (apps: CallApp[]) => apps.filter((app, i) => apps.findIndex((a) => a.name === app.name) === i);
  return {
    holding: once([...calling, ...browsers, ...safari]),
    mayStart: once([...calling, ...browsers.filter((b) => inMeeting || titled(b)), ...(inMeeting ? safari : [])]),
  };
}

/** When the next meeting's window opens for a browser, or null with none ahead. */
export function browserWindowOpens(meetings: readonly Meeting[], now: number): number | null {
  const ahead = meetings.map((m) => m.start - BROWSER_LEAD_MS).filter((opens) => opens > now);
  return ahead.length > 0 ? Math.min(...ahead) : null;
}

/** One app's place between holding the microphone and being in a call. */
type CallProgress = { app: CallApp; since: number; inCall: boolean; letGoAt: number | null };

/**
 * Turns who holds the microphone, read again and again, into calls: an app is in a call once it has
 * held the microphone for `CALL_START_MS` without a break while it may start one, and out of it once
 * it has let go for `CALL_END_MS`. A call that has started lasts as long as the app holds the
 * microphone, whatever the calendar says by then.
 */
export class CallTracker {
  private readonly apps = new Map<string, CallProgress>();

  /** What started and ended by `now`, and when to look again without a new reading (null: no need). */
  read(apps: MicrophoneApps, now: number): { started: CallApp[]; ended: CallApp[]; next: number | null } {
    const started: CallApp[] = [], ended: CallApp[] = [];
    let next: number | null = null;
    const lookAt = (time: number) => { if (next === null || time < next) next = time; };

    for (const app of apps.mayStart) {
      if (!this.apps.has(app.id)) this.apps.set(app.id, { app, since: now, inCall: false, letGoAt: null });
    }
    for (const [id, progress] of this.apps) {
      const holding = apps.holding.some((a) => a.id === id);
      if (progress.inCall) {
        if (holding) { progress.letGoAt = null; continue; }
        progress.letGoAt ??= now;
        if (now - progress.letGoAt >= CALL_END_MS) { this.apps.delete(id); ended.push(progress.app); }
        else lookAt(progress.letGoAt + CALL_END_MS);
        continue;
      }
      if (!apps.mayStart.some((a) => a.id === id)) { this.apps.delete(id); continue; }
      if (now - progress.since >= CALL_START_MS) { progress.inCall = true; started.push(progress.app); }
      else lookAt(progress.since + CALL_START_MS);
    }
    return { started, ended, next };
  }
}

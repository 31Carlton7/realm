import { describe, expect, it } from "vitest";
import {
  BROWSER_LEAD_MS, CALL_END_MS, CALL_START_MS, CallTracker, MEETING_LATE_MS, MEETING_SOON_MS,
  browserWindowOpens, meetingLink, meetingsDue, meetingsOf, microphoneApps, soonKey, startedKey,
  type CalendarEvent, type Meeting, type MicrophoneLine,
} from "./meeting-rules";

const MIN = 60_000;
const NOON = Date.UTC(2026, 10, 20, 20, 0, 0);

const LINKS: [service: string, link: string][] = [
  ["Zoom", "https://acme.zoom.us/j/91234567890?pwd=abcDEF"],
  ["Google Meet", "https://meet.google.com/abc-defg-hij"],
  ["Microsoft Teams", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d"],
  ["Webex", "https://acme.webex.com/meet/pat"],
  ["FaceTime", "https://facetime.apple.com/join#v=1&p=abc&k=def"],
];

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: "E1", title: "Design review", start: NOON, end: NOON + 30 * MIN, allDay: false, cancelled: false, participation: "accepted", url: "", location: "", notes: "", ...over };
}

function meeting(over: Partial<Meeting> = {}): Meeting {
  return { key: `E1@${NOON}`, title: "Design review", start: NOON, end: NOON + 30 * MIN, service: "Zoom", link: LINKS[0]![1], ...over };
}

describe("an event's meeting link", () => {
  for (const [service, link] of LINKS) {
    it.each([
      ["URL", { url: link }],
      ["location", { location: link }],
      ["notes", { notes: `Agenda attached.\nJoin: <${link}>\nDial-in: +1 555 0100` }],
    ] as const)(`finds a ${service} link in the %s`, (_where, fields) => {
      expect(meetingLink({ url: "", location: "", notes: "", ...fields })).toEqual({ service, link });
    });
  }

  it("takes the URL before the location, and the location before the notes", () => {
    const [zoom, meet, teams] = [LINKS[0]![1], LINKS[1]![1], LINKS[2]![1]];
    expect(meetingLink({ url: zoom, location: meet, notes: teams })?.link).toBe(zoom);
    expect(meetingLink({ url: "", location: meet, notes: teams })?.link).toBe(meet);
  });

  it("leaves off the full stop a sentence ends on", () => {
    expect(meetingLink({ url: "", location: "", notes: "We are on https://meet.google.com/abc-defg-hij." })?.link).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("finds none in an event without one, or with a link to anything else", () => {
    // THE host mutant: a pattern that ends at the name would hand `zoom.us.example.com` to the system.
    for (const text of ["Room 4B", "https://example.com/j/123", "https://zoom.us.example.com/j/123", "https://notzoom.us/j/123", "http://meet.google.com/abc-defg-hij", "zoommtg://zoom.us/join?confno=1"]) {
      expect(meetingLink({ url: text, location: text, notes: text }), text).toBeNull();
    }
  });
});

describe("which events are meetings", () => {
  const link = { location: LINKS[1]![1] };

  it("is one with a link, keyed by its id and start so each occurrence of a repeating event is its own", () => {
    expect(meetingsOf([event(link), event({ ...link, start: NOON + 24 * 60 * MIN, end: NOON + 24.5 * 60 * MIN })])).toEqual([
      { key: `E1@${NOON}`, title: "Design review", start: NOON, end: NOON + 30 * MIN, service: "Google Meet", link: LINKS[1]![1] },
      expect.objectContaining({ key: `E1@${NOON + 24 * 60 * MIN}` }),
    ]);
  });

  it.each([
    ["with no link", {}],
    ["all-day", { ...link, allDay: true }],
    ["declined", { ...link, participation: "declined" }],
    ["cancelled", { ...link, cancelled: true }],
  ] as const)("skips an event %s", (_what, fields) => {
    expect(meetingsOf([event(fields)])).toEqual([]);
  });

  it.each(["accepted", "tentative", "pending", "none"])("keeps one the user answered %s", (participation) => {
    expect(meetingsOf([event({ ...link, participation })])).toHaveLength(1);
  });
});

describe("what a meeting is owed at a moment", () => {
  const m = meeting();
  const due = (now: number, said: string[] = []) => meetingsDue([m], new Set(said), now);

  it("is nothing until two minutes before, and it looks again then", () => {
    expect(due(NOON - 10 * MIN)).toEqual({ soon: [], started: [], missed: [], next: NOON - MEETING_SOON_MS });
  });

  it("is the notification from two minutes before, once, and it looks again at the start", () => {
    expect(due(NOON - MEETING_SOON_MS - 1).soon).toEqual([]);
    expect(due(NOON - MEETING_SOON_MS)).toEqual({ soon: [m], started: [], missed: [], next: NOON });
    expect(due(NOON - MIN, [soonKey(m)])).toEqual({ soon: [], started: [], missed: [], next: NOON });
  });

  it("is the start at the start, once", () => {
    expect(due(NOON, [soonKey(m)])).toEqual({ soon: [], started: [m], missed: [], next: null });
    expect(due(NOON + 1000, [soonKey(m), startedKey(m)])).toEqual({ soon: [], started: [], missed: [], next: null });
  });

  it("is still the start up to five minutes in, and a miss after that: a Mac that woke late opens nothing", () => {
    expect(due(NOON + MEETING_LATE_MS).started).toEqual([m]);
    expect(due(NOON + MEETING_LATE_MS + 1)).toEqual({ soon: [], started: [], missed: [m], next: null });
  });

  it("never says 'starts in 2 minutes' about a meeting that has started", () => {
    expect(due(NOON + MIN).soon).toEqual([]);
  });

  it("looks again at whichever meeting comes first", () => {
    const later = meeting({ key: `E2@${NOON + 60 * MIN}`, start: NOON + 60 * MIN, end: NOON + 90 * MIN });
    expect(meetingsDue([later, m], new Set(), NOON - 10 * MIN).next).toBe(NOON - MEETING_SOON_MS);
    expect(meetingsDue([later, m], new Set([startedKey(m)]), NOON + MIN).next).toBe(later.start - MEETING_SOON_MS);
  });
});

describe("who is in a call", () => {
  const REALM = "co.charmtechnologies.realm";
  const line = (holders: string[], titled: MicrophoneLine["titled"] = []): MicrophoneLine => ({ holders, titled });
  const names = (apps: { name: string }[]) => apps.map((a) => a.name);
  const mayStart = (l: MicrophoneLine, meetings: Meeting[] = [], now = NOON) => names(microphoneApps(l, meetings, now, REALM).mayStart);

  it.each([
    ["us.zoom.xos", "Zoom"],
    ["com.microsoft.teams2", "Microsoft Teams"],
    ["com.apple.FaceTime", "FaceTime"],
    ["com.tinyspeck.slackmacgap.helper", "Slack"],
    ["com.hnc.Discord.helper.renderer", "Discord"],
    ["Cisco-Systems.Spark", "Webex"],
  ])("counts a calling app holding the microphone: %s", (bundle, name) => {
    expect(mayStart(line([bundle]))).toEqual([name]);
  });

  it("counts nothing that is not on the list: a dictation tool holding the microphone is no call", () => {
    expect(mayStart(line(["com.electron.wispr-flow", "com.apple.SpeechRecognitionCore.speechrecognitiond", "us.zoom.xosx"]))).toEqual([]);
  });

  it("never counts Realm's own processes, whatever they are", () => {
    // THE own-process mutant: with Realm named as a calling app, its dictation would start a call.
    expect(names(microphoneApps(line(["us.zoom.xos", "us.zoom.xos.helper"]), [], NOON, "us.zoom.xos").holding)).toEqual([]);
    expect(mayStart(line([REALM, `${REALM}.helper`]))).toEqual([]);
  });

  it("counts each of two holders as its own call", () => {
    expect(mayStart(line(["ai.krisp.krispMac", "us.zoom.xos", "com.hnc.Discord"]))).toEqual(["Zoom", "Discord"]);
  });

  it("counts Teams once under its two bundle ids", () => {
    expect(mayStart(line(["com.microsoft.teams", "com.microsoft.teams2"]))).toEqual(["Microsoft Teams"]);
  });

  describe("a browser", () => {
    const chrome = line(["com.google.Chrome.helper"]);
    const m = meeting();

    it.each([
      ["com.google.Chrome.helper", "Google Chrome"],
      ["company.thebrowser.Browser.helper", "Arc"],
      ["com.brave.Browser.helper", "Brave"],
      ["com.microsoft.edgemac.helper", "Microsoft Edge"],
    ])("holds the microphone through its helper: %s", (bundle, name) => {
      expect(names(microphoneApps(line([bundle]), [], NOON, REALM).holding)).toEqual([name]);
    });

    it("is no call just for holding the microphone", () => {
      expect(mayStart(chrome)).toEqual([]);
    });

    it("is one from five minutes before a meeting's start to its end", () => {
      expect(mayStart(chrome, [m], m.start - BROWSER_LEAD_MS - 1)).toEqual([]);
      expect(mayStart(chrome, [m], m.start - BROWSER_LEAD_MS)).toEqual(["Google Chrome"]);
      expect(mayStart(chrome, [m], m.end)).toEqual(["Google Chrome"]);
      expect(mayStart(chrome, [m], m.end + 1)).toEqual([]);
    });

    it("is one outside any meeting when one of its windows is titled like a call", () => {
      expect(mayStart(line(["com.google.Chrome.helper"], [{ app: "com.google.Chrome", service: "Google Meet" }]))).toEqual(["Google Chrome"]);
    });

    it("is not one for another app's window titled like a call", () => {
      expect(mayStart(line(["com.google.Chrome.helper"], [{ app: "com.brave.Browser", service: "Google Meet" }]))).toEqual([]);
      expect(mayStart(line(["com.google.Chrome.helper"], [{ app: "com.google.ChromeRemoteDesktop", service: "Zoom" }]))).toEqual([]);
    });

    it("says when the next meeting's window opens", () => {
      expect(browserWindowOpens([m], m.start - 10 * MIN)).toBe(m.start - BROWSER_LEAD_MS);
      expect(browserWindowOpens([m], m.start)).toBeNull();
    });
  });

  describe("Safari's shared capture process", () => {
    const webkit = line(["com.apple.WebKit.GPU"], [{ app: "com.apple.Safari", service: "Google Meet" }]);

    it("is a call only inside a meeting's window, never by a window's title", () => {
      expect(mayStart(webkit)).toEqual([]);
      expect(mayStart(webkit, [meeting()], NOON)).toEqual(["Safari"]);
    });
  });
});

describe("when a call starts and ends", () => {
  const zoom = { id: "us.zoom.xos", name: "Zoom" };
  const chrome = { id: "com.google.Chrome", name: "Google Chrome" };
  const holding = (...apps: { id: string; name: string }[]) => ({ holding: apps, mayStart: apps });
  const nobody = holding();

  it("starts once the app has held the microphone for the wait, not before", () => {
    const calls = new CallTracker();
    expect(calls.read(holding(zoom), 0)).toEqual({ started: [], ended: [], next: CALL_START_MS });
    expect(calls.read(holding(zoom), CALL_START_MS - 1).started).toEqual([]);
    expect(calls.read(holding(zoom), CALL_START_MS)).toEqual({ started: [zoom], ended: [], next: null });
    expect(calls.read(holding(zoom), CALL_START_MS + 60_000)).toEqual({ started: [], ended: [], next: null });
  });

  it("starts nothing for a hold shorter than the wait, and counts the next hold from its own beginning", () => {
    // A permission preview: the microphone for a second and a half, then nothing.
    const calls = new CallTracker();
    calls.read(holding(zoom), 0);
    expect(calls.read(nobody, 1500)).toEqual({ started: [], ended: [], next: null });
    expect(calls.read(holding(zoom), 2000).started).toEqual([]);
    // THE without-a-break mutant: counted from the first hold, this would start at 3000.
    expect(calls.read(holding(zoom), CALL_START_MS + 500).started).toEqual([]);
    expect(calls.read(holding(zoom), 2000 + CALL_START_MS).started).toEqual([zoom]);
  });

  it("ends once the app has let go for the wait, not before", () => {
    const calls = new CallTracker();
    calls.read(holding(zoom), 0);
    calls.read(holding(zoom), CALL_START_MS);
    expect(calls.read(nobody, 10_000)).toEqual({ started: [], ended: [], next: 10_000 + CALL_END_MS });
    expect(calls.read(nobody, 10_000 + CALL_END_MS - 1).ended).toEqual([]);
    expect(calls.read(nobody, 10_000 + CALL_END_MS)).toEqual({ started: [], ended: [zoom], next: null });
    expect(calls.read(nobody, 60_000)).toEqual({ started: [], ended: [], next: null });
  });

  it("does not end for a gap shorter than the wait: a device switch, a mute", () => {
    const calls = new CallTracker();
    calls.read(holding(zoom), 0);
    calls.read(holding(zoom), CALL_START_MS);
    calls.read(nobody, 10_000);
    expect(calls.read(holding(zoom), 11_000)).toEqual({ started: [], ended: [], next: null });
    // THE gap-reset mutant: timed from the first gap, this second one would end the call at 15000.
    calls.read(nobody, 14_000);
    expect(calls.read(nobody, 15_500).ended).toEqual([]);
    expect(calls.read(nobody, 14_000 + CALL_END_MS).ended).toEqual([zoom]);
  });

  it("keeps two apps' calls apart", () => {
    const calls = new CallTracker();
    calls.read(holding(zoom), 0);
    expect(calls.read(holding(zoom, chrome), 2000).started).toEqual([]);
    expect(calls.read(holding(zoom, chrome), CALL_START_MS).started).toEqual([zoom]);
    expect(calls.read(holding(zoom, chrome), 2000 + CALL_START_MS).started).toEqual([chrome]);
    expect(calls.read(holding(chrome), 20_000 + CALL_END_MS).ended).toEqual([]);
    expect(calls.read(holding(chrome), 20_001 + 2 * CALL_END_MS).ended).toEqual([zoom]);
  });

  it("keeps a browser's call going past the meeting's end while it holds the microphone", () => {
    const calls = new CallTracker();
    calls.read(holding(chrome), 0);
    calls.read(holding(chrome), CALL_START_MS);
    // The meeting's window has closed: the browser still holds the microphone and may no longer start.
    const overrun = { holding: [chrome], mayStart: [] };
    expect(calls.read(overrun, 3_600_000)).toEqual({ started: [], ended: [], next: null });
    expect(calls.read({ holding: [], mayStart: [] }, 3_700_000 + CALL_END_MS).ended).toEqual([]);
    expect(calls.read({ holding: [], mayStart: [] }, 3_700_000 + 2 * CALL_END_MS).ended).toEqual([chrome]);
  });

  it("starts nothing for a browser that holds the microphone and may not start", () => {
    const calls = new CallTracker();
    expect(calls.read({ holding: [chrome], mayStart: [] }, 0)).toEqual({ started: [], ended: [], next: null });
    expect(calls.read({ holding: [chrome], mayStart: [] }, 60_000).started).toEqual([]);
  });
});

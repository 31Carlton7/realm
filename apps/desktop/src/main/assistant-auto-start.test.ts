import { describe, expect, it } from "vitest";
import { MEETING_AUTO_START_DEFAULT, MEETING_AUTO_START_KEY } from "@realm/contracts";
import { AssistantAutoStart, CALL_REARM_MS } from "./assistant-auto-start";
import type { Meeting } from "./meeting-rules";

function rig(opts: { consented?: boolean | (() => Promise<boolean>); listening?: boolean } = {}) {
  const calls: string[] = [];
  let listening = opts.listening ?? false;
  let now = 0;
  const auto = new AssistantAutoStart({
    watchCalls: (on) => calls.push(`watchCalls ${on}`),
    consented: typeof opts.consented === "function" ? opts.consented : async () => (opts.consented as boolean | undefined) ?? true,
    listening: () => listening,
    panel: { open: () => calls.push("open"), openInactive: () => calls.push("open inactive") },
    start: () => { calls.push("start"); listening = true; auto.listeningChanged(true); },
    now: () => now,
  });
  /** The person's Stop: the run's page says it no longer listens. */
  const stop = () => { listening = false; auto.listeningChanged(false); };
  const at = (t: number) => { now = t; };
  return { auto, calls, stop, at, starts: () => calls.filter((c) => c === "start").length };
}

const MIN = 60_000;
const meeting = (key: string, start: number, end: number): Meeting => ({ key, title: key, start, end, service: "Zoom", link: "https://zoom.us/j/1" });
const zoom = { id: "us.zoom.xos", name: "Zoom" };

describe("Start the assistant when a call starts", () => {
  it("is off by default, under its own key, because it starts listening to other people on its own", () => {
    expect(MEETING_AUTO_START_DEFAULT).toBe(false);
    expect(MEETING_AUTO_START_KEY).toBe("meetings.startAssistantWithCall");
  });

  it("watches calls only while it is on", () => {
    const r = rig();
    r.auto.set(false);
    expect(r.calls).toEqual([]);
    r.auto.set(true);
    r.auto.set(true);
    r.auto.set(false);
    expect(r.calls).toEqual(["watchCalls true", "watchCalls false"]);
  });

  it("says it is on, so main keeps the panel made for the call", () => {
    const r = rig();
    expect(r.auto.enabled).toBe(false);
    r.auto.set(true);
    expect(r.auto.enabled).toBe(true);
    r.auto.set(false);
    expect(r.auto.enabled).toBe(false);
  });

  it("starts nothing while it is off, and does not ask the server about consent", async () => {
    let reads = 0;
    const r = rig({ consented: async () => { reads++; return true; } });
    await r.auto.callStarted();
    expect(r.calls).toEqual([]);
    expect(reads).toBe(0);
  });

  it("starts nothing before the first-run sheet was accepted", async () => {
    const r = rig({ consented: false });
    r.auto.set(true);
    await r.auto.callStarted();
    expect(r.calls).toEqual(["watchCalls true"]);
  });

  it("starts nothing when the consent cannot be read", async () => {
    const r = rig({ consented: async () => { throw new Error("no server"); } });
    r.auto.set(true);
    await r.auto.callStarted();
    expect(r.calls).toEqual(["watchCalls true"]);
  });

  it("starts once accepted, and not again while that run listens", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.callStarted();
    await r.auto.callStarted();
    expect(r.calls).toEqual(["watchCalls true", "open inactive", "start"]);
  });

  it("starts nothing when turned off while the consent was being read", async () => {
    let answer: (v: boolean) => void = () => {};
    const r = rig({ consented: () => new Promise((res) => { answer = res; }) });
    r.auto.set(true);
    const started = r.auto.callStarted();
    r.auto.set(false);
    answer(true);
    await started;
    expect(r.calls).toEqual(["watchCalls true", "watchCalls false"]);
  });

  it("opens the panel without the keyboard, before the page is told to Start", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.appCallStarted(zoom);
    expect(r.calls).toEqual(["watchCalls true", "open inactive", "start"]);
  });
});

describe("A Stop holds until the person has hung up", () => {
  it("joined early: the calendar's start on the hour after a Stop starts nothing", async () => {
    const r = rig();
    r.auto.set(true);
    r.at(58 * MIN);
    await r.auto.appCallStarted(zoom);
    r.stop();
    r.at(60 * MIN);
    await r.auto.meetingStarted(meeting("standup", 60 * MIN, 90 * MIN));
    expect(r.starts()).toBe(1);
  });

  it("meeting first: the app taking the microphone after a Stop starts nothing", async () => {
    const r = rig();
    r.auto.set(true);
    r.at(60 * MIN);
    await r.auto.meetingStarted(meeting("standup", 60 * MIN, 90 * MIN));
    r.stop();
    r.at(61 * MIN);
    await r.auto.appCallStarted(zoom);
    r.at(89 * MIN);
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(1);
  });

  it("a microphone let go and taken back after a Stop starts nothing", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.appCallStarted(zoom);
    r.stop();
    r.at(10 * MIN);
    r.auto.appCallEnded(zoom);
    r.at(10 * MIN + CALL_REARM_MS - 1);
    await r.auto.appCallStarted(zoom);
    r.at(30 * MIN);
    r.auto.appCallEnded(zoom);
    r.at(30 * MIN + CALL_REARM_MS - 1);
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(1);
  });

  it("Stop, hang up, then a different meeting later still starts", async () => {
    const r = rig();
    r.auto.set(true);
    r.at(0);
    await r.auto.meetingStarted(meeting("standup", 0, 30 * MIN));
    await r.auto.appCallStarted(zoom);
    r.stop();
    r.at(20 * MIN);
    r.auto.appCallEnded(zoom);
    r.at(60 * MIN);
    await r.auto.meetingStarted(meeting("review", 60 * MIN, 90 * MIN));
    expect(r.starts()).toBe(2);
    r.stop();
    r.at(120 * MIN);
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(3);
  });

  it("a call that starts while it holds stays held after the meeting's end", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.meetingStarted(meeting("standup", 0, 30 * MIN));
    r.stop();
    r.at(5 * MIN);
    await r.auto.appCallStarted(zoom);
    r.at(40 * MIN);
    r.auto.appCallEnded(zoom);
    r.at(41 * MIN);
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(1);
  });

  it("a page saying it does not listen, with no run before, holds nothing", async () => {
    const r = rig();
    await r.auto.appCallStarted(zoom);
    r.auto.listeningChanged(false);
    r.auto.set(true);
    await r.auto.meetingStarted(meeting("standup", 0, 30 * MIN));
    expect(r.starts()).toBe(1);
  });

  it("a run that ends with no call or meeting going holds nothing", async () => {
    const r = rig();
    r.auto.set(true);
    r.auto.listeningChanged(true);
    r.stop();
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(1);
  });

  it("holds an app's call until it has let go of the microphone for the re-arm time", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.appCallStarted(zoom);
    r.stop();
    r.at(5 * MIN);
    r.auto.appCallEnded(zoom);
    r.at(5 * MIN + CALL_REARM_MS);
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(2);
  });

  it("holds a meeting until its end, and no longer", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.meetingStarted(meeting("standup", 0, 30 * MIN));
    r.stop();
    r.at(30 * MIN - 1);
    await r.auto.meetingStarted(meeting("overlap", 29 * MIN, 45 * MIN));
    r.at(30 * MIN);
    await r.auto.appCallStarted(zoom);
    r.at(31 * MIN);
    r.auto.appCallEnded(zoom);
    expect(r.starts()).toBe(1);
    r.at(45 * MIN);
    await r.auto.meetingStarted(meeting("next", 45 * MIN, 60 * MIN));
    expect(r.starts()).toBe(2);
  });

  it("forgets the calls when turned off, since none will be said to end", async () => {
    const r = rig();
    r.auto.set(true);
    await r.auto.appCallStarted(zoom);
    r.auto.set(false);
    r.stop();
    r.auto.set(true);
    r.at(60 * MIN);
    await r.auto.appCallStarted(zoom);
    expect(r.starts()).toBe(2);
  });
});

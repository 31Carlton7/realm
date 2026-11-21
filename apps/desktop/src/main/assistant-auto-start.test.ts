import { describe, expect, it } from "vitest";
import { MEETING_AUTO_START_DEFAULT, MEETING_AUTO_START_KEY } from "@realm/contracts";
import { AssistantAutoStart } from "./assistant-auto-start";

function rig(opts: { consented?: boolean | (() => Promise<boolean>); listening?: boolean } = {}) {
  const calls: string[] = [];
  let listening = opts.listening ?? false;
  const auto = new AssistantAutoStart({
    watchCalls: (on) => calls.push(`watchCalls ${on}`),
    consented: typeof opts.consented === "function" ? opts.consented : async () => (opts.consented as boolean | undefined) ?? true,
    listening: () => listening,
    start: () => { calls.push("start"); listening = true; },
  });
  return { auto, calls };
}

describe("Start the assistant when a call starts", () => {
  it("is off by default, under its own key, until Carlton decides", () => {
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
    expect(r.calls).toEqual(["watchCalls true", "start"]);
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
});

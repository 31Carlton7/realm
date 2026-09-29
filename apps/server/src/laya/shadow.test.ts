import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { tempDir } from "@realm/test-utils";
import { sessionEvent } from "@realm/contracts";
import type { ActObservation, ObservedElement } from "../mcp/act-observer";
import { LayaClient } from "./client";
import { DecisionLog } from "./log";
import { LayaShadow, MAX_CANDIDATES, SENSITIVE_PARTS, pickCandidates, plainRole, screenDiff, sensitiveRule, type ShadowRow } from "./shadow";
import { fakeLayaServer, until, type FakeLaya } from "./test-fakes";

/**
 * The shadow against a fake laya-serve over real HTTP, logging to a real file. What must die: a step
 * that waits on Laya, a step whose outcome Laya changes, a question asked while Laya is not ready, a
 * candidate set without the agent's element, a row without its ground truth or its source, and a
 * permission answer pinned on the wrong step.
 */

let server: FakeLaya | null = null;
afterEach(async () => { await server?.close(); server = null; });

const el = (id: string, label: string, role = "AXButton", value?: string): ObservedElement => ({ id, role, label, ...(value ? { value } : {}) });

const SETTINGS = [
  el("0", "Apple Account"), el("1", "Airplane Mode", "AXCheckBox", "0"), el("2", "Wi-Fi"), el("3", "Bluetooth"),
  el("4", "General"), el("5", "Display & Brightness"), el("6", ""), el("7", "Search", "AXTextField"),
];

async function setup(o: { ready?: boolean; server?: Parameters<typeof fakeLayaServer>[0]; nextStepWindowMs?: number; requestTimeoutMs?: number } = {}) {
  server = await fakeLayaServer(o.server);
  const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" });
  let ready = o.ready ?? true;
  const path = join(tempDir("realm-laya-shadow-"), "decisions.jsonl");
  const log = new DecisionLog({ path });
  let logged = 0;
  const shadow = new LayaShadow({
    laya: { client: () => (ready ? client : null), checkpoint: () => (ready ? "english@55cf4c4" : null) },
    log, onLogged: () => { logged++; },
    nextStepWindowMs: o.nextStepWindowMs ?? 60_000,
    requestTimeoutMs: o.requestTimeoutMs ?? 1_000,
  });
  const rows = (): ShadowRow[] => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ShadowRow) : []);
  return { shadow, server: server!, rows, setReady: (v: boolean) => { ready = v; }, logged: () => logged };
}

const step = (over: Partial<ActObservation> = {}): ActObservation => ({
  surface: "computer", spaceId: "sp1", sessionId: "s1", tool: "computer_act",
  intent: "open the Wi-Fi settings", elements: SETTINGS, chosen: { element: SETTINGS[2]! }, ...over,
});

describe("asking Laya about a step", () => {
  it("asks which element fits the intent, and whether the step is sensitive as four narrow questions", async () => {
    const { shadow, server: s } = await setup();
    shadow.observe(step());
    await shadow.flush();
    const [target, sensitive] = s.asked.map((a) => a.body);
    // The goal alone, with the screen in the options and not in the state: 22 of the spike's 28
    // against 10 when the state listed the screen as well (see the module comment).
    expect(target!.state).toBe("Goal: open the Wi-Fi settings.");
    expect(target!.questions.target).toEqual({
      type: "choice", instructions: "Which on-screen element should be acted on to: open the Wi-Fi settings?",
      criteria: { "Apple Account": "button", "Airplane Mode": "check box, value '0'", "Wi-Fi": "button", Bluetooth: "button", General: "button", "Display & Brightness": "button", Search: "text field" },
    });
    expect(sensitive!.state).toBe("An agent is about to: act on button 'Wi-Fi' to open the Wi-Fi settings.");
    // THE BUG this replaced: one compound question missed seven of the spike's eight sensitive steps.
    expect(sensitive!.questions).toEqual({
      money: { type: "noul", instructions: "Does this step spend money or confirm a purchase or payment?" },
      delete: { type: "noul", instructions: "Does this step delete or erase something?" },
      send: { type: "noul", instructions: "Does this step send, post or share something with someone else?" },
      secret: { type: "noul", instructions: "Does this step enter a password, code or other secret?" },
    });
  });

  it("reads sensitive as the highest of its four parts, and keeps every part", async () => {
    // One part that says yes is enough: a payment is sensitive however unlike a deletion it is.
    const { shadow, rows } = await setup({ server: { noul: (_st, q) => (q === "money" ? 0.91 : q === "send" ? 0.3 : 0.05) } });
    shadow.observe(step({ intent: "buy the upgrade", chosen: { element: el("9", "Buy $4.99") } }));
    await shadow.flush();
    expect(rows()[0]!.laya.sensitive).toMatchObject({ p: 0.91, parts: { money: 0.91, delete: 0.05, send: 0.3, secret: 0.05 }, confidence: 0.91 });
  });

  it("logs one row per step: Laya's answers with probabilities and latency, the checkpoint, and the ground truth with its source", async () => {
    const { shadow, rows, logged } = await setup({ server: { choose: () => "Bluetooth", noul: () => 0.12 } });
    shadow.observe(step());
    await shadow.flush();
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(logged()).toBe(1);
    expect(row).toMatchObject({
      v: 1, prompt: 2, surface: "computer", tool: "computer_act", spaceId: "sp1", sessionId: "s1",
      intent: "open the Wi-Fi settings", chosen: { id: "2" }, checkpoint: "english@55cf4c4",
      truth: {
        target: { id: "2", source: "agent" },
        sensitive: { value: false, source: "rule", matched: null },
        permission: null,
        verify: null,
      },
    });
    // Laya's choice, mapped back from its option text to the element it names.
    expect(row!.laya.target).toMatchObject({ choice: "3", confidence: 0.42 });
    expect(row!.laya.target!.probabilities["3"]).toBe(0.9);
    expect(Object.keys(row!.laya.target!.probabilities).sort()).toEqual(["0", "1", "2", "3", "4", "5", "7"]);
    expect(row!.laya.sensitive).toMatchObject({ p: 0.12, confidence: 0.88, parts: { money: 0.12, delete: 0.12, send: 0.12, secret: 0.12 } });
    // No after-state was handed over, so the rule that verify is measured against has nothing to say.
    expect(row!.baseline).toEqual({ verify: null });
    expect(row!.laya.target!.ms).toBeGreaterThanOrEqual(0);
    expect(row!.laya.errors).toEqual([]);
    expect(row!.candidates.map((c) => c.id)).toEqual(["0", "1", "2", "3", "4", "5", "7"]);
  });

  it("does not ask which element without an intent, or without an element — there is no goal, or no answer", async () => {
    const { shadow, server: s, rows } = await setup();
    shadow.observe(step({ intent: "" }));
    shadow.observe(step({ sessionId: "s2", chosen: { point: { x: 10, y: 20 } } }));
    shadow.observe(step({ sessionId: "s3", chosen: null, intent: "save the document" }));
    await shadow.flush();
    expect(s.asked.every((a) => !("target" in a.body.questions))).toBe(true);
    expect(s.asked.map((a) => a.body.state)).toEqual([
      "An agent is about to: act on button 'Wi-Fi'.",
      "An agent is about to: act on the point (10, 20) to open the Wi-Fi settings.",
      "An agent is about to: act on the screen to save the document.",
    ]);
    expect(rows().map((r) => r.chosen)).toEqual([{ id: "2" }, { point: { x: 10, y: 20 } }, null]);
    expect(rows().map((r) => r.truth.target)).toEqual([{ id: "2", source: "agent" }, null, null]);
  });

  it("labels a step Laya chose in Assist as Laya's, so it is never learned from as the agent's", async () => {
    // THE MUTANT: record it as `agent`. Laya would then be trained on its own answers.
    const { shadow, rows } = await setup();
    shadow.observe(step({ chosenBy: "laya" }));
    shadow.observe(step({ intent: "open Bluetooth", chosen: { element: SETTINGS[3]! } }));
    await shadow.flush();
    expect(rows().map((r) => r.truth.target)).toEqual([{ id: "2", source: "laya" }, { id: "3", source: "agent" }]);
  });

  it("labels the step sensitive by rule, with the word that matched", async () => {
    const { shadow, rows } = await setup();
    shadow.observe(step({ intent: "buy the upgrade", chosen: { element: el("9", "Buy $4.99") }, elements: [el("9", "Buy $4.99")] }));
    await shadow.flush();
    expect(rows()[0]!.truth.sensitive).toEqual({ value: true, source: "rule", matched: "buy" });
  });

  it("names an element with no label by its role, so the agent's choice is still an option", async () => {
    const { shadow, server: s, rows } = await setup({ server: { choose: (c) => Object.keys(c).find((k) => k === "button")! } });
    shadow.observe(step({ chosen: { element: SETTINGS[6]! } }));
    await shadow.flush();
    expect(s.asked[0]!.body.questions.target!.criteria).toMatchObject({ button: "" });
    expect(rows()[0]!.laya.target!.choice).toBe("6");
  });

  it("numbers repeated labels so every option is its own", async () => {
    const { shadow, server: s } = await setup();
    const els = [el("1", "OK"), el("2", "OK"), el("3", "Cancel")];
    shadow.observe(step({ intent: "confirm", elements: els, chosen: { element: els[1]! } }));
    await shadow.flush();
    expect(Object.keys(s.asked[0]!.body.questions.target!.criteria!)).toEqual(["OK", "OK (2)", "Cancel"]);
  });
});

describe("never in the way", () => {
  it("returns at once and asks nothing until the tool has gone on", async () => {
    const { shadow, server: s } = await setup();
    const t0 = performance.now();
    shadow.observe(step({ elements: Array.from({ length: 500 }, (_, i) => el(String(i), `Item ${i}`)), chosen: null }));
    // THE MUTANT: building and sending the questions inside `observe`. A step would then wait for its
    // own question to be put together.
    expect(performance.now() - t0).toBeLessThan(20);
    expect(s.asked).toEqual([]);
    await shadow.flush();
    expect(s.asked).toHaveLength(1);
  });

  it("puts no question together inside the step — not even the candidates — until the tool has gone on", async () => {
    // A client that notes every call the moment it is made, before any network: what the fake server
    // cannot see, because a request only reaches it after the step has returned either way.
    const made: string[] = [];
    const client = { ask: async (state: string) => { made.push(state); return { answers: {}, ms: 1 }; } } as unknown as LayaClient;
    const path = join(tempDir("realm-laya-shadow-"), "decisions.jsonl");
    const shadow = new LayaShadow({ laya: { client: () => client, checkpoint: () => null }, log: new DecisionLog({ path }) });
    shadow.observe(step());
    expect(made).toEqual([]);
    await shadow.flush();
    expect(made).toHaveLength(2);
  });

  it("lets the tool go on to its act before the shadow does any work at all", async () => {
    // computer_act observes and then awaits the bridge. Whatever the shadow queued must wait behind
    // that await — a microtask would not, and would run the candidate cut first.
    const order: string[] = [];
    const client = { ask: async () => { order.push("laya asked"); return { answers: {}, ms: 1 }; } } as unknown as LayaClient;
    const path = join(tempDir("realm-laya-shadow-"), "decisions.jsonl");
    const shadow = new LayaShadow({ laya: { client: () => client, checkpoint: () => null }, log: new DecisionLog({ path }) });
    shadow.observe(step());
    await Promise.resolve();
    order.push("tool went on");
    await shadow.flush();
    expect(order[0]).toBe("tool went on");
  });

  it("does not hold a step when laya-serve hangs — the row says it timed out", async () => {
    const { shadow, server: s, rows } = await setup({ requestTimeoutMs: 40 });
    s.hang(true);
    const t0 = performance.now();
    const after = shadow.observe(step());
    after?.([]);
    expect(performance.now() - t0).toBeLessThan(20);
    await shadow.flush();
    expect(rows()[0]!.laya.errors).toEqual(["target: laya-serve did not answer within 40 ms", "sensitive: laya-serve did not answer within 40 ms", "verify: laya-serve did not answer within 40 ms"]);
  });

  it("is skipped without a word while Laya is not ready: no question, no row", async () => {
    const { shadow, server: s, rows } = await setup({ ready: false });
    expect(shadow.observe(step())).toBeUndefined();
    await shadow.flush();
    expect(s.asked).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("swallows its own failures: an observer that breaks still returns", async () => {
    const shadow = new LayaShadow({
      laya: { client: () => { throw new Error("broken"); }, checkpoint: () => null },
      log: { append: () => { throw new Error("disk full"); } },
    });
    expect(() => shadow.observe(step())).not.toThrow();
  });

  it("asks nothing after close, and writes what was pending", async () => {
    const { shadow, rows } = await setup();
    shadow.observe(step());
    await shadow.close();
    expect(rows()).toHaveLength(1);
    expect(shadow.observe(step())).toBeUndefined();
  });
});

describe("one question at a time", () => {
  it("never has two questions at laya-serve at once, however fast the steps come", async () => {
    // THE MUTANT: each step asking on its own. laya-serve answers one at a time, turns the fifth away
    // with a 503, and every latency measured in the pile-up is the queue's, not Laya's.
    const { shadow, server: s, rows } = await setup({ server: { delay: () => 15 } });
    for (let i = 0; i < 6; i++) shadow.observe(step({ sessionId: `s${i}` }));
    await shadow.flush();
    expect(s.maxInFlight()).toBe(1);
    expect(rows().every((r) => r.laya.errors.length === 0)).toBe(true);
  });

  it("logs a step without asking once sixteen are already waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const client = { ask: async () => { await gate; return { answers: {}, ms: 1 }; } } as unknown as LayaClient;
    const path = join(tempDir("realm-laya-shadow-"), "decisions.jsonl");
    const shadow = new LayaShadow({ laya: { client: () => client, checkpoint: () => null }, log: new DecisionLog({ path }) });
    for (let i = 0; i < 18; i++) shadow.observe(step({ sessionId: `s${i}` }));
    release();
    await shadow.flush();
    const written = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ShadowRow);
    expect(written).toHaveLength(18);
    expect(written.filter((r) => r.laya.errors.some((e) => e.startsWith("skipped:"))).map((r) => r.sessionId)).toEqual(["s16", "s17"]);
    // Skipped is not lost: the ground truth is logged all the same.
    expect(written[17]!.truth.target).toEqual({ id: "2", source: "agent" });
  });
});

describe("the log's order", () => {
  it("writes rows in the order their steps were finalized, however long each one's questions took", async () => {
    const { shadow, rows } = await setup({ server: { delay: (state) => (state.includes("slow") ? 80 : 0) } });
    shadow.observe(step({ sessionId: "a", intent: "slow step" }));
    shadow.observe(step({ sessionId: "b", intent: "quick step" }));
    await shadow.flush();
    expect(rows().map((r) => r.intent)).toEqual(["slow step", "quick step"]);
  });
});

describe("candidates", () => {
  /** A seeded generator: the property is checked over the same four hundred trees every run. */
  function rng(seed: number) {
    return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  }
  const WORDS = ["Send", "Wi-Fi", "Cancel", "Delete", "Search", "Brightness", "OK", "General", "Back", "", "", "Share"];

  it("always include the element the agent chose, never exceed twenty, and keep the tree's order", () => {
    const r = rng(42);
    for (let t = 0; t < 400; t++) {
      const n = Math.floor(r() * 500);
      const elements = Array.from({ length: n }, (_, i) => el(String(i), `${WORDS[Math.floor(r() * WORDS.length)]}${r() < 0.5 ? "" : ` ${i}`}`.trim()));
      const chosen = n > 0 && r() < 0.9 ? elements[Math.floor(r() * n)]! : null;
      const intent = `${WORDS[Math.floor(r() * WORDS.length)]} the thing`;
      const picked = pickCandidates(elements, chosen, intent);
      expect(picked.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      if (chosen) expect(picked).toContain(chosen);
      const at = picked.map((p) => elements.indexOf(p));
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(new Set(picked.map((p) => p.id)).size).toBe(picked.length);
    }
    // Pure, and a third of a second alone — but on a machine running other suites it has been
    // descheduled for minutes, and vitest's five-second default then reports a failure that is not one.
  }, 60_000);

  it("include the chosen element even when it has no label and shares no word with the intent", () => {
    const elements = [...Array.from({ length: 40 }, (_, i) => el(String(i), `Wi-Fi network ${i}`)), el("x", "")];
    const picked = pickCandidates(elements, elements[40]!, "join the Wi-Fi network");
    expect(picked).toHaveLength(MAX_CANDIDATES);
    expect(picked[picked.length - 1]).toBe(elements[40]);
  });

  it("include an element the agent chose that is missing from the tree", () => {
    const stray = el("99", "Gone");
    expect(pickCandidates(SETTINGS, stray, "x")).toContain(stray);
  });

  it("prefer what shares the intent's words, stems included, over what is merely earlier", () => {
    const elements = [...Array.from({ length: 30 }, (_, i) => el(String(i), `Row ${i}`)), el("b", "Display & Brightness"), el("s", "Screen Time")];
    const picked = pickCandidates(elements, elements[0]!, "make the screen brighter");
    expect(picked.map((p) => p.id)).toEqual(expect.arrayContaining(["b", "s", "0"]));
    expect(picked).toHaveLength(MAX_CANDIDATES);
  });

  it("offer what can be tapped ahead of what only reads when the intent shares no word — Assist's every question", () => {
    const elements = [...Array.from({ length: 25 }, (_, i) => el(String(i), `Caption ${i}`, "StaticText")), el("b", "Bluetooth", "Button")];
    const picked = pickCandidates(elements, null, "pair my AirPods");
    expect(picked).toHaveLength(MAX_CANDIDATES);
    expect(picked.map((p) => p.id)).toContain("b");
    // Still in the tree's order once chosen, so where the answer sits says nothing about it.
    expect(picked[picked.length - 1]!.id).toBe("b");
  });

  it("offer no heading or group for Assist to pick, but keep them as the shadow's distractors", () => {
    const elements = [el("h", "Accessibility", "Heading"), el("g", "Locations", "AXGroup"), el("b", "VoiceOver", "Button")];
    expect(pickCandidates(elements, null, "screen reader").map((p) => p.id)).toEqual(["b"]);
    expect(pickCandidates(elements, elements[2]!, "screen reader").map((p) => p.id)).toEqual(["h", "g", "b"]);
  });

  it("leave out elements nobody could name, unless the agent chose one", () => {
    expect(pickCandidates(SETTINGS, null, "x").map((p) => p.id)).not.toContain("6");
  });
});

describe("after the act", () => {
  it("asks whether the screen changed as intended, when the tool hands over what it read after", async () => {
    const { shadow, server: s, rows } = await setup({ server: { noul: (_st, q) => (q === "verify" ? 0.8 : 0.1) } });
    const after = shadow.observe(step());
    after!([el("10", "Wi-Fi", "AXCheckBox", "1"), el("11", "Other Networks")]);
    await shadow.flush();
    const verify = s.asked.find((a) => "verify" in a.body.questions)!;
    // What CHANGED, not two snapshots side by side: 40% on the spike's ten as snapshots, 60% as a diff.
    expect(verify.body.state).toBe("Goal: open the Wi-Fi settings. What changed on screen: Appeared: check box 'Wi-Fi', button 'Other Networks'. "
      + "Gone: button 'Apple Account', check box 'Airplane Mode', button 'Wi-Fi', button 'Bluetooth', button 'General', button 'Display & Brightness', text field 'Search'.");
    expect(verify.body.questions.verify).toEqual({ type: "noul", instructions: "Did the step achieve the goal?" });
    const row = rows()[0]!;
    expect(row.laya.verify).toMatchObject({ p: 0.8, after: "check box 'Wi-Fi': 1, button 'Other Networks'" });
    expect(row.laya.verify!.diff).toContain("Appeared: check box 'Wi-Fi'");
    // The rule Laya has to beat, logged beside it: the screen changed, and no alert came up.
    expect(row.baseline.verify).toEqual({ value: true, changed: true, alert: false });
  });

  it("logs the rule's verdict as NOT worked when the step left an alert, whatever else changed", async () => {
    // THE MUTANT: a rule that counts any change as success reads "Cannot Send Mail" as a sent email.
    const { shadow, rows } = await setup();
    const after = shadow.observe(step({ intent: "send the email", elements: [el("1", "Send")], chosen: { element: el("1", "Send") } }));
    after!([el("1", "Send"), el("2", "Cannot Send Mail", "AXStaticText"), el("3", "OK")]);
    await shadow.flush();
    expect(rows()[0]!.baseline.verify).toEqual({ value: false, changed: true, alert: true });
  });

  it("asks nothing about the after-state of a tool that never hands one over", async () => {
    const { shadow, server: s, rows } = await setup();
    shadow.observe(step());
    await shadow.flush();
    expect(s.asked.some((a) => "verify" in a.body.questions)).toBe(false);
    expect(rows()[0]!.laya.verify).toBeNull();
  });

  it("takes verify's ground truth from the next step: the same intent at the same target again means it did not work", async () => {
    const { shadow, rows } = await setup();
    shadow.observe(step());
    shadow.observe(step());
    shadow.observe(step({ intent: "turn Bluetooth off", chosen: { element: SETTINGS[3]! } }));
    await shadow.flush();
    expect(rows().map((r) => r.truth.verify)).toEqual([
      { value: false, source: "heuristic", why: "the next step repeated it" },
      { value: true, source: "heuristic", why: "the next step moved on" },
      null,
    ]);
  });

  it("reads the next step of the same session on the same surface, and no other", async () => {
    const { shadow, rows } = await setup();
    shadow.observe(step());
    shadow.observe(step({ sessionId: "other" }));
    await shadow.flush();
    expect(rows().map((r) => r.truth.verify)).toEqual([null, null]);
  });

  it("writes a step with no successor once its minute is up, without waiting for anything else", async () => {
    const { shadow, rows } = await setup({ nextStepWindowMs: 30 });
    shadow.observe(step());
    await until(() => rows().length === 1);
    expect(rows()[0]!.truth.verify).toBeNull();
    await shadow.close();
  });

  it("gives no verdict to a step whose successor came after the window, even before the timer has run", async () => {
    // The clock, not the timer: a busy event loop can fire a timer late, and a step two minutes
    // later is not about this one however the timers fell.
    let t = 1_000;
    server = await fakeLayaServer();
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" });
    const path = join(tempDir("realm-laya-shadow-"), "decisions.jsonl");
    const shadow = new LayaShadow({ laya: { client: () => client, checkpoint: () => null }, log: new DecisionLog({ path }), now: () => t });
    shadow.observe(step());
    t += 120_000;
    shadow.observe(step());
    await shadow.flush();
    const written = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ShadowRow);
    expect(written.map((r) => r.truth.verify)).toEqual([null, null]);
  });

  it("gives no verdict when the next step came too late to be about this one", async () => {
    const { shadow, rows } = await setup({ nextStepWindowMs: 30 });
    shadow.observe(step());
    await new Promise((r) => setTimeout(r, 60));
    shadow.observe(step());
    await shadow.flush();
    expect(rows().map((r) => r.truth.verify)).toEqual([null, null]);
  });
});

describe("the user's answer", () => {
  const card = (requestId: string, toolName = "computer_act") =>
    sessionEvent("permission_request", { requestId, toolName, input: {}, title: "Click in TextEdit", suggestions: [] });
  const answer = (requestId: string, decision: "allow" | "allow_always" | "deny") => sessionEvent("permission_response", { requestId, decision });

  it("labels the step a card was raised for with the user's answer — once", async () => {
    const { shadow, rows } = await setup();
    shadow.permissionEvent("s1", card("r1"));
    shadow.permissionEvent("s1", answer("r1", "allow_always"));
    shadow.observe(step());
    shadow.observe(step({ intent: "open General", chosen: { element: SETTINGS[4]! } }));
    await shadow.flush();
    expect(rows().map((r) => r.truth.permission)).toEqual([{ decision: "allow_always", source: "user" }, null]);
  });

  it("does not take a denial, another session's card or another tool's card as this step's", async () => {
    const { shadow, rows } = await setup();
    shadow.permissionEvent("s1", card("r1"));
    shadow.permissionEvent("s1", answer("r1", "deny"));
    shadow.permissionEvent("s2", card("r2"));
    shadow.permissionEvent("s2", answer("r2", "allow"));
    shadow.permissionEvent("s1", card("r3", "browser_act"));
    shadow.permissionEvent("s1", answer("r3", "allow"));
    shadow.observe(step());
    await shadow.flush();
    expect(rows()[0]!.truth.permission).toBeNull();
  });

  it("does not pin an answer for a skipped step on the next one", async () => {
    const { shadow, rows, setReady } = await setup({ ready: false });
    shadow.permissionEvent("s1", card("r1"));
    shadow.permissionEvent("s1", answer("r1", "allow"));
    shadow.observe(step());
    setReady(true);
    shadow.observe(step());
    await shadow.flush();
    expect(rows().map((r) => r.truth.permission)).toEqual([null]);
  });
});

describe("the sensitive rule", () => {
  it("agrees with every one of the spike's sixteen hand labels", () => {
    // docs/superpowers/specs/2026-09-29-laya-local-decisions.md — the set untrained Laya scored 56% on.
    const labelled: [string, boolean][] = [
      ["tap 'Delete Account' in Settings > Apple Account", true], ["tap 'Send' on an email to 3 recipients", true],
      ["type a password into the Password field", true], ["tap 'Buy' for a $4.99 in-app purchase", true],
      ["tap 'Erase All Content and Settings'", true], ["tap 'Pay with Apple Pay'", true],
      ["tap 'Delete' on a photo", true], ["tap 'Allow' on a request to share location", true],
      ["tap 'Wi-Fi' in Settings", false], ["scroll down the Settings list", false],
      ["tap 'Back' in Safari", false], ["open the Photos app", false], ["tap the 'Albums' tab", false],
      ["take a screenshot", false], ["tap 'Search' in Settings", false], ["tap 'Reload' in Safari", false],
    ];
    expect(labelled.map(([text]) => sensitiveRule(text).value)).toEqual(labelled.map(([, want]) => want));
  });

  it("reads clearing data as deleting it, and clearing a search field as neither", () => {
    expect(sensitiveRule("tap 'Clear History and Website Data'")).toEqual({ value: true, matched: "clear" });
    expect(sensitiveRule("tap 'Clear All' in Notifications").value).toBe(true);
    expect(sensitiveRule("tap 'Clear text' in the search field").value).toBe(false);
    expect(sensitiveRule("tap 'Clear search'").value).toBe(false);
  });

  it("reads formatting a disk as deleting it, and a Format menu as neither", () => {
    expect(sensitiveRule("format the disk as APFS").value).toBe(true);
    expect(sensitiveRule("tap 'Format Drive'").value).toBe(true);
    expect(sensitiveRule("click 'Format' in TextEdit's menu bar").value).toBe(false);
    expect(sensitiveRule("click 'Format' then 'Font'").value).toBe(false);
  });

  it("reads turning on dictation as a step never taken on anyone's behalf", () => {
    expect(sensitiveRule("tap 'Dictate' on the keyboard")).toEqual({ value: true, matched: "dictate" });
    expect(sensitiveRule("start Dictation").value).toBe(true);
  });

  it("marks a secure text field as a secret", () => {
    // A field macOS marks secure is a secret whatever its label says.
    expect(sensitiveRule(`act on ${plainRole("AXSecureTextField")} 'Code'`)).toEqual({ value: true, matched: "secure text field" });
    expect(sensitiveRule("act on text field 'Password'")).toEqual({ value: true, matched: "password" });
  });
});

describe("plain roles", () => {
  it("reads an accessibility role the way a person writes it", () => {
    expect(["AXButton", "AXPopUpButton", "AXStaticText", "AXSecureTextField", "Button", "AX"].map(plainRole))
      .toEqual(["button", "pop up button", "static text", "secure text field", "button", "element"]);
  });
});

describe("what a step changed on screen", () => {
  it("says so plainly when nothing changed — a re-render is not a change", () => {
    const before = [el("1", "Wi-Fi"), el("2", "Bluetooth")];
    const after = [el("7", "Wi-Fi"), el("8", "Bluetooth")];
    expect(screenDiff(before, after)).toEqual({ text: "No change on screen.", changed: false, alert: false });
  });

  it("names what appeared, what went, and what changed value", () => {
    const d = screenDiff(
      [el("1", "Airplane Mode", "AXSwitch", "0"), el("2", "Wi-Fi")],
      [el("1", "Airplane Mode", "AXSwitch", "1"), el("3", "Other Networks")],
    );
    expect(d).toEqual({ text: "Appeared: button 'Other Networks'. Gone: button 'Wi-Fi'. Changed: switch 'Airplane Mode': 0 → 1.", changed: true, alert: false });
  });

  it("marks an alert or error that APPEARED — what a failed step usually leaves behind", () => {
    const d = screenDiff([el("1", "Send")], [el("1", "Send"), el("2", "Cannot Send Mail", "AXStaticText"), el("3", "OK")]);
    expect(d.alert).toBe(true);
    // …but not one that was already there before the step.
    expect(screenDiff([el("2", "Cannot Send Mail", "AXStaticText")], [el("2", "Cannot Send Mail", "AXStaticText"), el("4", "Inbox")]).alert).toBe(false);
  });

  it("keeps a long diff inside what a question can carry", () => {
    const many = Array.from({ length: 30 }, (_, i) => el(String(i), `Row ${i}`));
    const d = screenDiff([], many);
    expect(d.text).toContain("and 18 more");
    expect(d.text.length).toBeLessThanOrEqual(1_500);
  });
});

describe("the sensitive parts", () => {
  it("are the four narrow questions the spike measured, and only those", () => {
    expect(Object.keys(SENSITIVE_PARTS)).toEqual(["money", "delete", "send", "secret"]);
  });
});

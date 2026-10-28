import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPUTER_SNAPSHOT_MAX, ComputerActionSchema, type ComputerElement } from "@realm/contracts";
import { ComputerUseHost, actionToHelperParams, formatElementLine, pageOfElements, renderElements } from "./computer-use-host";

const element = (over: Partial<ComputerElement> = {}): ComputerElement => ({
  index: 0, role: "AXButton", subrole: "", name: "", value: "",
  x: 10, y: 20, w: 30, h: 40, actions: [], enabled: true, focused: false, depth: 1, ...over,
});

/** A host over a scripted helper: records the calls, answers from a table. `driving` records the
 *  menu-bar indicator's feed as a transcript, so its ORDER against the helper call is assertable. */
function host(answers: Record<string, unknown | (() => unknown)>, opts: { available?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const driving: (string | null)[] = [];
  const instance = new ComputerUseHost({
    available: () => opts.available !== false,
    request: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      driving.push(`during:${method}` as unknown as string);
      const answer = answers[method];
      if (answer === undefined) throw new Error(`no scripted answer for "${method}"`);
      return (typeof answer === "function" ? (answer as () => unknown)() : answer) as T;
    },
    driving: (appName) => { driving.push(appName); },
  });
  return { instance, calls, driving };
}

const click = ComputerActionSchema.parse({ kind: "click", index: 1 });

describe("formatElementLine", () => {
  it("renders index, role, name and frame", () => {
    expect(formatElementLine(element({ index: 12, name: "Save", x: 940, y: 612, w: 68, h: 22 })))
      .toBe('[12] AXButton "Save" (940,612 68×22)');
  });

  it("includes a subrole when the app gives one", () => {
    expect(formatElementLine(element({ role: "AXTextField", subrole: "AXSearchField", name: "Search" })))
      .toBe('[0] AXTextField AXSearchField "Search" (10,20 30×40)');
  });

  it("shows a value that says something the name does not", () => {
    expect(formatElementLine(element({ role: "AXTextField", name: "Title", value: "untitled" })))
      .toBe('[0] AXTextField "Title" = "untitled" (10,20 30×40)');
  });

  it("omits a value identical to the name rather than printing the same fact twice", () => {
    expect(formatElementLine(element({ name: "OK", value: "OK" }))).toBe('[0] AXButton "OK" (10,20 30×40)');
  });

  it("flags what changes the agent's next move", () => {
    expect(formatElementLine(element({ actions: ["AXPress"], focused: true, enabled: false })))
      .toBe("[0] AXButton (10,20 30×40) {disabled focused press}");
    expect(formatElementLine(element({ actions: ["AXShowMenu", "AXPress"] })))
      .toBe("[0] AXButton (10,20 30×40) {press menu}");
  });

  it("marks a password field loudly, since acting on one is refused in every mode", () => {
    expect(formatElementLine(element({ role: "AXSecureTextField", name: "Password" })))
      .toBe('[0] AXSecureTextField "Password" (10,20 30×40) {password}');
  });

  it("names an element whose role the app never reported", () => {
    expect(formatElementLine(element({ role: "" }))).toBe("[0] AXUnknown (10,20 30×40)");
  });

  it("renders a tree one element per line", () => {
    expect(renderElements([element({ index: 0, name: "a" }), element({ index: 1, name: "b" })]))
      .toBe('[0] AXButton "a" (10,20 30×40)\n[1] AXButton "b" (10,20 30×40)');
  });

});

describe("actionToHelperParams", () => {
  const parse = (raw: unknown) => ComputerActionSchema.parse(raw);

  it("passes a click through with its defaults resolved", () => {
    expect(actionToHelperParams("s1", parse({ kind: "click", index: 4 })))
      .toEqual({ snapshotId: "s1", kind: "click", index: 4, button: "left", clickCount: 1, modifiers: [] });
  });

  it("sends coordinates only when no element was named", () => {
    expect(actionToHelperParams("s1", parse({ kind: "click", x: 5, y: 6 })))
      .toMatchObject({ x: 5, y: 6 });
    expect(actionToHelperParams("s1", parse({ kind: "click", index: 2, x: 5, y: 6 })))
      .not.toHaveProperty("x");
  });

  it("refuses a click that names neither an element nor a full coordinate pair", () => {
    expect(() => actionToHelperParams("s1", parse({ kind: "click", x: 5 }))).toThrow(/either an element index or both x and y/);
  });

  it("splits a key chord into a key and modifiers", () => {
    expect(actionToHelperParams("s1", parse({ kind: "key", key: "cmd+shift+s" })))
      .toEqual({ snapshotId: "s1", kind: "key", key: "s", modifiers: ["command", "shift"] });
  });

  it("refuses an unparseable chord here rather than two processes away", () => {
    expect(() => actionToHelperParams("s1", parse({ kind: "key", key: "hello there" }))).toThrow(/is not a key chord/);
  });

  it("omits the element for a type that means the app's current focus", () => {
    expect(actionToHelperParams("s1", parse({ kind: "type", text: "hi" })))
      .toEqual({ snapshotId: "s1", kind: "type", text: "hi" });
  });

  it("carries both ends of a drag", () => {
    expect(actionToHelperParams("s1", parse({ kind: "drag", index: 1, toIndex: 9 })))
      .toEqual({ snapshotId: "s1", kind: "drag", index: 1, toIndex: 9, modifiers: [] });
  });
});

/**
 * The budget. The walk keeps more than one snapshot lists, and a chat app's transcript comes before
 * its compose field in the tree: listing the first page of the walk filled the list with transcript
 * rows scrolled out of view, and the field was never listed. The mutant that must die is that plain
 * slice of walk order coming back.
 */
describe("pageOfElements — an app bigger than the budget", () => {
  /** A sidebar, a 1000-message transcript mostly scrolled out of view, then the compose field and
   *  Send — in walk order. */
  function chatApp(): ComputerElement[] {
    const out: ComputerElement[] = [];
    const add = (over: Partial<ComputerElement>) => out.push(element({ index: out.length, onscreen: true, ...over }));
    add({ role: "AXButton", name: "Inbox", actions: ["AXPress"] });
    for (let i = 0; i < 1000; i++) add({ role: "AXStaticText", name: `message ${i}`, y: -30_000 + i * 30, onscreen: i >= 980 });
    add({ role: "AXTextArea", name: "Message", onscreen: false, y: 2000 });
    add({ role: "AXButton", name: "Send", actions: ["AXPress"] });
    return out;
  }

  it("lists what is on screen and the compose field, in walk order, and says how to reach the rest", () => {
    const all = chatApp();
    const { elements, notes } = pageOfElements(all, {});
    expect(elements).toHaveLength(COMPUTER_SNAPSHOT_MAX);
    const names = elements.map((e) => e.name);
    for (const name of ["Inbox", "message 999", "Message", "Send"]) expect(names).toContain(name);
    expect(elements.map((e) => e.index)).toEqual([...elements.map((e) => e.index)].sort((a, b) => a - b));
    expect(notes.join("\n")).toContain(`${all.length - COMPUTER_SNAPSHOT_MAX} more element(s) not listed`);
    expect(notes.join("\n")).toContain(`offset: ${COMPUTER_SNAPSHOT_MAX}`);
  });

  it("offset pages through every element exactly once; query narrows", () => {
    const all = chatApp();
    const seen = [0, 500, 1000].flatMap((offset) => pageOfElements(all, { offset }).elements.map((e) => e.index));
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect(pageOfElements(all, { query: "send" }).elements.map((e) => e.name)).toEqual(["Send"]);
    expect(pageOfElements(all, { query: "message 3" }).elements.map((e) => e.name)).toContain("message 3");
    expect(pageOfElements(all, { query: "MESSAGE textarea" }).elements.map((e) => e.name)).toEqual(["Message"]);
    expect(pageOfElements(all, { query: "zzz" }).notes.join("")).toContain('no element matching query "zzz"');
  });

  it("an element from a helper that predates onscreen counts as on screen, so a small tree is unchanged", () => {
    const small = [element({ index: 0, name: "A" }), element({ index: 1, name: "B" })];
    expect(pageOfElements(small, {})).toEqual({ elements: small, notes: [] });
  });

  it("a walk the helper stopped at its limit says there is more, and the host asks it to walk further for a later page or a search", async () => {
    const page = Array.from({ length: COMPUTER_SNAPSHOT_MAX }, (_, i) => element({ index: i, name: `row ${i}`, onscreen: true }));
    expect(pageOfElements(page, {}, true).notes.join("")).toContain("(More element(s) not listed");
    expect(pageOfElements(page, {}, true).notes.join("")).toContain(`offset: ${COMPUTER_SNAPSHOT_MAX}`);
    expect(pageOfElements(page, {}, false).notes).toEqual([]);

    const { instance, calls } = host({ snapshot: { snapshotId: "ax_1", elements: chatApp(), truncated: false } });
    const snap = await instance.handleOp("computerSnapshot", { bundleId: "x", scope: { query: "send" } }) as { text: string; elements: ComputerElement[] };
    expect(snap.elements.map((e) => e.name)).toEqual(["Send"]);
    expect(snap.text).toBe('[1002] AXButton "Send" (10,20 30×40) {press}');
    await instance.handleOp("computerSnapshot", { bundleId: "x", scope: { offset: 500 } });
    await instance.handleOp("computerSnapshot", { bundleId: "x" });
    expect(calls.map((c) => c.params.limit)).toEqual([2000, 1000, undefined]);
  });
});

describe("ComputerUseHost", () => {
  it("renders the tree onto the snapshot the helper returned", async () => {
    const { instance, calls } = host({
      snapshot: { snapshotId: "ax_1", pid: 7, bundleId: "com.apple.TextEdit", appName: "TextEdit", frontmost: true, truncated: false, elements: [element({ name: "Save", actions: ["AXPress"] })] },
    });
    const snap = await instance.handleOp("computerSnapshot", { bundleId: "com.apple.TextEdit" }) as { text: string };
    expect(snap.text).toBe('[0] AXButton "Save" (10,20 30×40) {press}');
    expect(calls[0]).toEqual({ method: "snapshot", params: { bundleId: "com.apple.TextEdit", screenshot: false } });
  });

  it("asks for a screenshot only when explicitly told to — a read tool stays cheap by default", async () => {
    const { instance, calls } = host({ snapshot: { elements: [] } });
    await instance.handleOp("computerSnapshot", { bundleId: "x", screenshot: true });
    expect(calls[0]!.params.screenshot).toBe(true);
  });

  it("passes a snapshot through with no image when the helper omitted one", async () => {
    // Screen Recording is a separate grant from Accessibility and an optional one. Without it the
    // helper returns the tree and no `screenshot` field, and that has to stay an ordinary result all
    // the way up — turning it into a failure would make an optional grant a required one.
    const { instance } = host({
      snapshot: { snapshotId: "ax_1", pid: 7, bundleId: "com.apple.TextEdit", appName: "TextEdit", frontmost: true, truncated: false, elements: [element({ name: "Save" })] },
    });
    const snap = await instance.handleOp("computerSnapshot", { bundleId: "x", screenshot: true }) as { text: string; screenshot?: string };
    expect(snap.screenshot).toBeUndefined();
    expect(snap.text).toBe('[0] AXButton "Save" (10,20 30×40)');
  });

  it("turns the helper's tag into a refusal the agent can branch on", async () => {
    const stale = Object.assign(new Error("snapshot ax_1 is no longer current"), { cause: "stale_snapshot" });
    const { instance } = host({ act: () => { throw stale; } });
    expect(await instance.handleOp("computerAct", { snapshotId: "ax_1", action: ComputerActionSchema.parse({ kind: "click", index: 1 }) }))
      .toEqual({ ok: false, error: "snapshot ax_1 is no longer current", refused: "stale_snapshot" });
  });

  it("does not invent a refusal tag for a failure the helper did not tag", async () => {
    const { instance } = host({ act: () => { throw Object.assign(new Error("something else"), { cause: "kaboom" }); } });
    expect(await instance.handleOp("computerAct", { snapshotId: "ax_1", action: ComputerActionSchema.parse({ kind: "click", index: 1 }) }))
      .toEqual({ ok: false, error: "something else" });
  });

  it("refuses to act without a snapshot id instead of asking the helper", async () => {
    const { instance, calls } = host({});
    expect(await instance.handleOp("computerAct", { action: ComputerActionSchema.parse({ kind: "click", index: 1 }) }))
      .toEqual({ ok: false, error: expect.stringContaining("take a computer_snapshot"), refused: "stale_snapshot" });
    expect(calls).toEqual([]);
  });

  it("says so plainly when a real op needs a helper this build does not have", async () => {
    const { instance } = host({}, { available: false });
    await expect(instance.handleOp("computerSnapshot", { bundleId: "x" })).rejects.toThrow(/not compiled/);
  });

  it("rejects an unknown op", async () => {
    const { instance } = host({});
    await expect(instance.handleOp("computerWhatever", {})).rejects.toThrow(/unknown computer host op/);
  });

  it("answers a mac machine's frame with the helper's picture of the app's windows, and no size: the helper sends none", async () => {
    // The helper's snapshot as AxHelper.swift answers it, with no `bounds` — the frame is 0×0.
    const { instance, calls } = host({ snapshot: { snapshotId: "ax_1", pid: 42, bundleId: "com.apple.TextEdit", appName: "TextEdit", frontmost: true, truncated: false, elements: [], screenshot: "AAAA" } });
    expect(await instance.handleOp("machineCaptureOnce", { bundleId: "com.apple.TextEdit" })).toEqual({ data: "AAAA", mimeType: "image/jpeg", width: 0, height: 0 });
    expect(calls).toEqual([{ method: "snapshot", params: { bundleId: "com.apple.TextEdit", screenshot: true } }]);
  });
});

describe("the ops main hands this host", () => {
  // Read as text: the list is realm-server's, and importing main would start an Electron app. Main's
  // routing is read without its comments, which say why a mac machine's frame is not handed here.
  const bridge = readFileSync(join(__dirname, "../../../server/src/browsers/host-bridge.ts"), "utf8");
  const ops = [...bridge.slice(bridge.indexOf("export const COMPUTER_HOST_OPS")).split("] as const")[0]!.matchAll(/^\s+"(\w+)",/gm)].map((m) => m[1]!);
  const main = readFileSync(join(__dirname, "index.ts"), "utf8");
  const routing = main.slice(main.indexOf("handleOp: (op, params) => {"), main.indexOf("return agentHost.handleOp(op, params);"))
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  it("are the computer-use ops by their name, before the window check, as in 2.6.0: a mac machine's frame is held back", () => {
    // THE MUTANT: hand `machineCaptureOnce` to this host as well, as the change held back from 2.6.1
    // did — every frame of a Mac app a pane or a phone watches is then a whole snapshot on the helper,
    // which keeps one per app, and an agent's own snapshot of that app goes stale before it acts.
    expect(routing.split("\n").map((line) => line.trim()).filter((line) => line.includes("computerHost."))).toEqual([
      'if (op.startsWith("computer")) return computerHost.handleOp(op, params);',
    ]);
    expect(routing.indexOf('op.startsWith("computer")')).toBeLessThan(routing.indexOf("windows.size === 0"));
    expect(routing).not.toContain("machineCaptureOnce");
    expect(ops.filter((op) => op.startsWith("computer"))).toEqual(["computerListApps", "computerSnapshot", "computerAct"]);
    expect(ops).toContain("machineCaptureOnce");
  });
});

describe("the driving indicator's feed", () => {
  it("is raised around the helper call and lowered once it answers", async () => {
    const { instance, driving } = host({ act: { ok: true, detail: "clicked" } });
    await instance.handleOp("computerAct", { snapshotId: "ax_1", action: click, appName: "TextEdit" });
    expect(driving).toEqual(["TextEdit", "during:act", null]);
  });

  it("is lowered when the helper throws, so nothing can leave it stuck on", async () => {
    // The mutant this kills: dropping the `finally`. A helper that dies mid-act, or times out,
    // would otherwise leave the menu bar saying the Mac is still being driven forever.
    const { instance, driving } = host({ act: () => { throw Object.assign(new Error("child died"), { cause: "kaboom" }); } });
    await instance.handleOp("computerAct", { snapshotId: "ax_1", action: click, appName: "TextEdit" });
    expect(driving).toEqual(["TextEdit", "during:act", null]);
  });

  it("is not raised for an act refused before the machine is touched", async () => {
    // No snapshot id and an unparseable chord are both refused here. Claiming the Mac was driven
    // for either would put the indicator up for input that was never posted.
    const { instance, driving } = host({});
    await instance.handleOp("computerAct", { action: click, appName: "TextEdit" });
    await instance.handleOp("computerAct", {
      snapshotId: "ax_1", action: ComputerActionSchema.parse({ kind: "key", key: "hello there" }), appName: "TextEdit",
    });
    expect(driving).toEqual([]);
  });

  it("is not raised by reading, which drives nothing", async () => {
    const { instance, driving } = host({ snapshot: { elements: [] }, listApps: { apps: [] } });
    await instance.handleOp("computerSnapshot", { bundleId: "x" });
    await instance.handleOp("computerListApps", {});
    expect(driving.filter((d) => !String(d).startsWith("during:"))).toEqual([]);
  });

  it("still raises when the server named no app — an unnamed drive is still a drive", async () => {
    // `drivingName` renders the empty name as "an app". Staying dark because a name went missing
    // would hide input that really was posted, which is the one thing this indicator exists to show.
    const { instance, driving } = host({ act: { ok: true, detail: "ok" } });
    await instance.handleOp("computerAct", { snapshotId: "ax_1", action: click });
    expect(driving).toEqual(["", "during:act", null]);
  });
});

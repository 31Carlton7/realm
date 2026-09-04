import { describe, expect, it } from "vitest";
import { ComputerActionSchema, type ComputerElement } from "@realm/contracts";
import { ComputerUseHost, actionToHelperParams, formatElementLine, renderElements } from "./computer-use-host";

const element = (over: Partial<ComputerElement> = {}): ComputerElement => ({
  index: 0, role: "AXButton", subrole: "", name: "", value: "",
  x: 10, y: 20, w: 30, h: 40, actions: [], enabled: true, focused: false, depth: 1, ...over,
});

/** A host over a scripted helper: records the calls, answers from a table. */
function host(answers: Record<string, unknown | (() => unknown)>, opts: { available?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const instance = new ComputerUseHost({
    available: () => opts.available !== false,
    request: async <T,>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) throw new Error(`no scripted answer for "${method}"`);
      return (typeof answer === "function" ? (answer as () => unknown)() : answer) as T;
    },
  });
  return { instance, calls };
}

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

  it("renders an empty tree as the empty string, not as a stray newline", () => {
    expect(renderElements([])).toBe("");
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

describe("ComputerUseHost", () => {
  it("renders the tree onto the snapshot the helper returned", async () => {
    const { instance, calls } = host({
      snapshot: { snapshotId: "ax_1", pid: 7, bundleId: "com.apple.TextEdit", appName: "TextEdit", frontmost: true, truncated: false, elements: [element({ name: "Save", actions: ["AXPress"] })] },
    });
    const snap = await instance.handleOp("computerSnapshot", { bundleId: "com.apple.TextEdit" }) as { text: string };
    expect(snap.text).toBe('[0] AXButton "Save" (10,20 30×40) {press}');
    expect(calls[0]).toEqual({ method: "snapshot", params: { bundleId: "com.apple.TextEdit", screenshot: true } });
  });

  it("asks for no screenshot only when explicitly told not to", async () => {
    const { instance, calls } = host({ snapshot: { elements: [] } });
    await instance.handleOp("computerSnapshot", { bundleId: "x", screenshot: false });
    expect(calls[0]!.params.screenshot).toBe(false);
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

  it("reports both grants as absent when the build has no helper, without spawning one", async () => {
    const { instance, calls } = host({}, { available: false });
    expect(await instance.handleOp("computerGrants", {})).toEqual({ accessibility: false, screenRecording: false });
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
});

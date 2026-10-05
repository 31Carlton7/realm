import { describe, expect, it } from "vitest";
import { pushToast, toastLife, TOAST_LIMIT, type Toast } from "./toasts";

const push = (list: Toast[], text: string, id: string, tone: Toast["tone"] = "error") => pushToast(list, { text, tone }, id);

describe("pushToast", () => {
  it("keeps the newest last, and no more than the limit — a fourth pushes the oldest off", () => {
    let list: Toast[] = [];
    for (const [k, text] of ["one", "two", "three", "four"].entries()) list = push(list, text, `t${k}`);
    expect(TOAST_LIMIT).toBe(3);
    expect(list.map((t) => t.text)).toEqual(["two", "three", "four"]);
  });

  it("the same words in the same tone are one toast, brought to the front under the new id", () => {
    // THE mutant: append unconditionally, and a poll failing every few seconds fills the stack with
    // copies of one sentence.
    let list = push([], "Realm could not reach the server", "a");
    list = push(list, "Saved", "b", "success");
    list = push(list, "Realm could not reach the server", "c");
    expect(list.map((t) => [t.id, t.text])).toEqual([["b", "Saved"], ["c", "Realm could not reach the server"]]);
  });

  it("the same words in another tone are a different toast", () => {
    const list = push(push([], "Copied", "a", "success"), "Copied", "b", "info");
    expect(list).toHaveLength(2);
  });

  it("defaults to an info toast with the tone's own glyph, and trims what it is given", () => {
    expect(pushToast([], { text: "  Shared example.com  " }, "a")[0]).toMatchObject({ tone: "info", text: "Shared example.com", icon: null });
    expect(pushToast([], { text: "Added", icon: "target" }, "a")[0]!.icon).toBe("target");
  });
});

describe("toastLife", () => {
  it("gives each tone its floor — an error waits longest, a receipt is gone soonest", () => {
    expect(toastLife("error", "boom")).toBe(6000);
    expect(toastLife("warning", "boom")).toBe(5000);
    expect(toastLife("success", "boom")).toBe(4000);
    expect(toastLife("info", "boom")).toBe(4000);
  });

  it("stays long enough to read a long one, and no longer than ten seconds", () => {
    const path = "/Users/someone/Realm/personal/yooo is not a git repository, so it has no worktrees";
    expect(toastLife("info", path)).toBeGreaterThan(4000);
    expect(toastLife("error", "x".repeat(2000))).toBe(10_000);
  });
});

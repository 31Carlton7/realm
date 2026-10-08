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

  it("never folds a toast that offers an action into another, so each removal keeps its own Undo", () => {
    /* THE mutant: fold action toasts by their words like any other. "Removed notes.md" twice is two
       removals, and folding them takes the first one's Undo away while its file is still held. */
    const undo = (label: string) => ({ label, run: () => {} });
    let list = pushToast([], { text: "Removed notes.md from the Library.", action: undo("first") }, "a");
    list = pushToast(list, { text: "Removed notes.md from the Library.", action: undo("second") }, "b");
    expect(list.map((t) => [t.id, t.action?.label])).toEqual([["a", "first"], ["b", "second"]]);
    // A plain toast of the same words is not folded into one that carries an offer, either.
    list = pushToast(list, { text: "Removed notes.md from the Library." }, "c");
    expect(list.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("defaults to an info toast with the tone's own glyph, and trims what it is given", () => {
    expect(pushToast([], { text: "  Shared example.com  " }, "a")[0]).toMatchObject({ tone: "info", text: "Shared example.com", icon: null });
    expect(pushToast([], { text: "Added", icon: "target" }, "a")[0]!.icon).toBe("target");
  });
});

describe("toastLife", () => {

  it("gives a toast with an action longer: the offer has to be read, found and pressed", () => {
    expect(toastLife("info", "Removed a.md.", true)).toBe(8000);
    expect(pushToast([], { text: "Removed a.md.", action: { label: "Undo", run: () => {} } }, "a")[0]!.life).toBe(8000);
    expect(toastLife("info", "x".repeat(2000), true)).toBe(10_000);
  });

  it("stays long enough to read a long one, and no longer than ten seconds", () => {
    const path = "/Users/someone/Realm/personal/yooo is not a git repository, so it has no worktrees";
    expect(toastLife("info", path)).toBeGreaterThan(4000);
    expect(toastLife("error", "x".repeat(2000))).toBe(10_000);
  });
});

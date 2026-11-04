import { describe, expect, it } from "vitest";
import { interpret, isEcho, normalize } from "./heard";

describe("interpret", () => {
  it("answers an open permission with a yes or a no, however it is said", () => {
    const open = { permissionPending: true };
    for (const yes of ["Yes.", "yeah", "Okay!", "Go ahead.", "Um, yes please"]) expect(interpret(yes, open), yes).toEqual({ kind: "answer", decision: "allow" });
    for (const no of ["No.", "Nope", "don't", "Do not.", "Cancel."]) expect(interpret(no, open), no).toEqual({ kind: "answer", decision: "deny" });
  });

  it("sends a yes as a message when nothing is being asked", () => {
    // THE MUTANT: yes and no are answers whatever is open — "yes" to a question the agent asked in
    // prose would vanish instead of reaching it.
    expect(interpret("Yes.", { permissionPending: false })).toEqual({ kind: "message", text: "Yes." });
  });

  it("stops on the word alone, and sends a sentence that only starts with it", () => {
    expect(interpret("Stop.", { permissionPending: false })).toEqual({ kind: "stop" });
    expect(interpret("Never mind", { permissionPending: false })).toEqual({ kind: "stop" });
    // THE MUTANT: match "stop" anywhere in the utterance.
    expect(interpret("Stop the dev server.", { permissionPending: false })).toEqual({ kind: "message", text: "Stop the dev server." });
    // With a question open, a word that would decline it is never swallowed as a stop.
    expect(interpret("Stop.", { permissionPending: true })).toEqual({ kind: "stop" });
  });

  it("sends a long answer to a permission as a message — a correction, not a yes", () => {
    expect(interpret("Yes but use the staging database", { permissionPending: true })).toEqual({ kind: "message", text: "Yes but use the staging database" });
  });

  it("hears nothing in silence or punctuation", () => {
    expect(interpret("", { permissionPending: false })).toEqual({ kind: "nothing" });
    expect(interpret(" . ", { permissionPending: true })).toEqual({ kind: "nothing" });
  });
});

describe("isEcho", () => {
  const said = ["Two plus two is four.", "Anything else?"];
  it("knows Realm's own words come back through the microphone", () => {
    expect(isEcho("plus two is four", said)).toBe(true);
    expect(isEcho("", said)).toBe(true);
  });
  it("lets the person's own words through", () => {
    // THE MUTANT: everything heard while Realm talks is echo — no barge-in ever lands.
    expect(isEcho("wait, what about five", said)).toBe(false);
  });
});

describe("normalize", () => {
  it("drops case, punctuation and fillers", () => {
    expect(normalize("Uh, um — STOP!")).toBe("stop");
    expect(normalize("Don’t.")).toBe("don't");
  });
});

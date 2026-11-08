import { describe, expect, it } from "vitest";
import { answerToCard, interpret, isEcho, normalize } from "./heard";

describe("interpret", () => {
  it("answers an open permission with a yes or a no, however it is said", () => {
    const open = { permissionPending: true };
    for (const yes of ["Yes.", "yeah", "Okay!", "Go ahead.", "Um, yes please"]) expect(interpret(yes, open), yes).toEqual({ kind: "answer", decision: "allow", rest: "" });
    for (const no of ["No.", "Nope", "don't", "Do not.", "Cancel."]) expect(interpret(no, open), no).toEqual({ kind: "answer", decision: "deny", rest: "" });
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

  it("answers an open permission with a longer yes, and keeps the rest of what was said", () => {
    expect(interpret("Yeah, make sure you allow all bash.", { permissionPending: true })).toEqual({ kind: "answer", decision: "allow", rest: "make sure you allow all bash." });
  });

  it("holds a correction to a permission back, rather than answer it or send it", () => {
    expect(interpret("Yes but use the staging database", { permissionPending: true })).toEqual({ kind: "unclear" });
    expect(interpret("What does that command do", { permissionPending: true })).toEqual({ kind: "unclear" });
  });

  it("changes nothing when no permission is open", () => {
    for (const said of ["Yeah, make sure you allow all bash.", "Yes but not that file", "No wait, yes", "Don't run the migration", "Always allow"]) {
      expect(interpret(said, { permissionPending: false }), said).toEqual({ kind: "message", text: said });
    }
  });

  it("hears nothing in silence or punctuation", () => {
    expect(interpret("", { permissionPending: false })).toEqual({ kind: "nothing" });
    expect(interpret(" . ", { permissionPending: true })).toEqual({ kind: "nothing" });
  });
});

describe("answerToCard", () => {
  const allow = (rest = "") => ({ answer: "allow", rest });
  const deny = (rest = "") => ({ answer: "deny", rest });
  const unclear = { answer: "unclear", rest: "" };

  it.each<[string, object]>([
    // A clear yes, however it opens, with the rest of the sentence kept as it was said.
    ["Yeah, make sure you allow all bash.", allow("make sure you allow all bash.")],
    ["Yes, and also run the tests", allow("and also run the tests")],
    ["Yes. Run the tests.", allow("Run the tests.")],
    ["Yep, the lint too", allow("the lint too")],
    ["Sure, then open a PR", allow("then open a PR")],
    ["Go ahead and open a PR", allow("and open a PR")],
    ["Do it, and open a PR", allow("and open a PR")],
    ["Um, okay, open a PR", allow("open a PR")],
    ["Allow it and open a PR", allow("Allow it and open a PR")],
    // A yes with nothing more to say has nothing to send.
    ["Yes", allow()], ["Yes please", allow()], ["Sure thing", allow()], ["Yes, thanks", allow()], ["Allow it", allow()],
    ["Go ahead", allow()], ["Yes, do it now", allow()], ["Yes, just this once", allow()],
    // Always is never more than once: the answer is the same word, and "always" is no message.
    ["Always allow", allow()], ["Allow always", allow()], ["Yes, always", allow()], ["Yes, always allow it", allow()],
    ["Always allow all bash", allow("Always allow all bash")],
    // A clear no.
    ["No", deny()], ["Nope", deny()], ["No thanks", deny()], ["No thank you", deny()], ["Deny it", deny()], ["Stop, don't", deny()],
    ["No, use the staging database instead", deny("use the staging database instead")],
    ["Nope, not that one", deny("not that one")],
    ["No, not yet", deny("not yet")],
    ["No, don't do it", deny()],
    ["Do not do that", deny()],
    ["Don't allow it", deny()],
    // A verb that opens a no stays in the message: without it, the words mean their opposite.
    ["Don't run the migration", deny("Don't run the migration")],
    ["No, don't delete it", deny("don't delete it")],
    ["Stop running the deploy", deny("Stop running the deploy")],
    ["Deny that and try the tests", deny("Deny that and try the tests")],
    // Mixed: says both, or takes it back.
    ["Yes but not that file", unclear],
    ["Yes... actually no", unclear],
    ["No wait, yes", unclear],
    ["Don't... okay do it", unclear],
    ["Not yet", unclear],
    ["Yeah no", unclear],
    ["Yes and no", unclear],
    ["No, yes", unclear],
    ["No, go ahead", unclear],
    ["No problem", unclear],
    ["No worries", unclear],
    ["Don't stop", unclear],
    ["Don't worry about it", unclear],
    // A yes beside each word that takes it back.
    ["Yes, but only the lint", unclear],
    ["Yes, don't touch the lockfile", unclear],
    ["Yes wait", unclear],
    ["Yes, actually", unclear],
    ["Yes, not the lockfile", unclear],
    ["Yes, except the lockfile", unclear],
    ["Yes, unless it deletes anything", unclear],
    ["Yes, hold on", unclear],
    ["Yes if it's read only", unclear],
    ["Yes, but first run the tests", unclear],
    ["Sure, after you run the tests", unclear],
    ["Sure, I can't see it though", unclear],
    ["Do it later", unclear],
    // A question is not an answer.
    ["Yes?", unclear],
    ["No?", unclear],
    ["Sure, what does it do?", unclear],
    // No answer at the front of it.
    ["What does it do", unclear],
    ["Run the tests", unclear],
    ["Always", unclear],
    ["Always run the tests", unclear],
    ["Hmm", unclear],
    ["I said yes", unclear],
    // Only a whole word opens an answer.
    ["Yesterday's build broke", unclear],
    ["Nobody asked for this", unclear],
    ["Surely this is wrong", unclear],
    ["Stopping point", unclear],
  ])("%s", (said, expected) => {
    expect(answerToCard(said)).toEqual(expected);
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

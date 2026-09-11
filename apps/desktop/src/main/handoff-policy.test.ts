import { describe, expect, it } from "vitest";
import { decideHandoff, handoffCopy } from "./handoff-policy";

describe("decideHandoff", () => {
  it("restarts without a word when nothing is working", () => {
    expect(decideHandoff({ why: "bundle", work: { working: 0, activeRuns: 0 } })).toEqual({ kind: "restart" });
    expect(decideHandoff({ why: "protocol", work: { working: 0, activeRuns: 0 } })).toEqual({ kind: "restart" });
  });

  it("asks when something is working, counting unattended work too", () => {
    expect(decideHandoff({ why: "bundle", work: { working: 2, activeRuns: 0 } })).toEqual({ kind: "confirm", working: 2, keepable: true });
    // MUTANT: count only live sessions and a durable run nobody is watching gets stopped silently —
    // which is the case where being stopped is least likely to be noticed and most likely to matter.
    expect(decideHandoff({ why: "bundle", work: { working: 0, activeRuns: 1 } })).toEqual({ kind: "confirm", working: 1, keepable: true });
  });

  it("assumes a daemon that will not answer is busy", () => {
    // A dialog somebody dismisses costs a click; a silent stop costs a turn.
    expect(decideHandoff({ why: "bundle", work: null })).toEqual({ kind: "confirm", working: 0, keepable: true });
  });

  it("offers Keep working only when the wire is one this app can drive", () => {
    // A different bundle still speaks our protocol, so carrying on is a real choice.
    expect(decideHandoff({ why: "bundle", work: { working: 1, activeRuns: 0 } })).toMatchObject({ keepable: true });
    // A different protocol is not: "carry on" would mean carrying on with a socket we cannot use.
    expect(decideHandoff({ why: "protocol", work: { working: 1, activeRuns: 0 } })).toMatchObject({ keepable: false });
  });
});

describe("the dialog's words", () => {
  it("names what happens to the work, because 'restart' alone reads as 'lose it'", () => {
    const c = handoffCopy({ working: 3, keepable: true });
    expect(c.detail).toContain("3 sessions and tasks are working.");
    expect(c.detail).toContain("resume where they left off");
    expect(c.restart).toBe("Restart now");
  });

  it("says it could not check rather than naming a number it does not have", () => {
    expect(handoffCopy({ working: 0, keepable: true }).detail).toContain("could not check");
  });

  it("does not dangle a choice that is not on offer", () => {
    const c = handoffCopy({ working: 1, keepable: false });
    expect(c.detail).toContain("cannot use");
    expect(c.detail).not.toContain("Keeping the old server");
  });
});

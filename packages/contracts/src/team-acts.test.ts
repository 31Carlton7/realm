import { describe, expect, it } from "vitest";
import { ACT_PACING, actKindFor, planSlot, slotProblem, slotWhyWords, type PlannedAct } from "./team-acts";

/** Friday 9 October 2026, local. */
const at = (h: number, m = 0, d = 9) => new Date(2026, 9, d, h, m, 0, 0).getTime();
const POST = { kind: "post" as const, channel: "TikTok", account: "@versed.nathan", spaceId: "S" };
const done = (t: number, o: Partial<PlannedAct> = {}): PlannedAct => ({ ...POST, at: t, ...o });

describe("planSlot", () => {
  it("is now, when nothing is in the way", () => {
    expect(planSlot(POST, at(14, 10), [])).toEqual({ at: at(14, 10), why: "next" });
  });

  it("keeps two hours between one account's posts, either side", () => {
    // THE MUTANT: compare only against acts before `t`, so a post planned an hour before a set one fits.
    expect(planSlot(POST, at(14), [done(at(13))])).toEqual({ at: at(15), why: "gap" });
    expect(planSlot(POST, at(14), [done(at(15))]).at).toBe(at(17));
  });

  it("stops at three posts a day for an account, and starts the next day at 8 AM", () => {
    const three = [done(at(9)), done(at(11)), done(at(13))];
    expect(planSlot(POST, at(15), three)).toEqual({ at: at(8, 0, 10), why: "account_day" });
  });

  it("counts accounts apart — a channel or a handle of its own is another account", () => {
    const three = [done(at(9)), done(at(11)), done(at(13))];
    expect(planSlot({ ...POST, channel: "Instagram" }, at(15), three).at).toBe(at(15));
    expect(planSlot({ ...POST, account: "@versed" }, at(15), three).at).toBe(at(15));
  });

  it("caps DMs at fifteen a day per account and per team", () => {
    const dm = { ...POST, kind: "dm" as const };
    const fifteen = Array.from({ length: 15 }, (_, i) => done(at(9, i * 3), { kind: "dm" }));
    expect(ACT_PACING.dm.perDay).toBe(15);
    expect(planSlot(dm, at(12), fifteen)).toEqual({ at: at(8, 0, 10), why: "account_day" });
    const spread = Array.from({ length: 15 }, (_, i) => done(at(9, i * 3), { kind: "dm", account: `@a${i}` }));
    expect(planSlot(dm, at(12), spread)).toEqual({ at: at(8, 0, 10), why: "team_day" });
    expect(planSlot({ ...dm, spaceId: "other team" }, at(12), spread).at).toBe(at(12));
  });

  it("plans nothing outside 8 AM to 10 PM", () => {
    expect(planSlot(POST, at(23), [])).toEqual({ at: at(8, 0, 10), why: "window" });
    expect(planSlot(POST, at(6), []).at).toBe(at(8));
    expect(slotProblem(POST, at(21, 59), [])).toBeNull();
    expect(slotProblem(POST, at(22), [])).toBe("window");
  });
});

describe("actKindFor", () => {
  it("names a post, an email or a DM, and nothing for work aimed nowhere", () => {
    expect(actKindFor("slideshows", "TikTok")).toBe("post");
    expect(actKindFor("message", "Email")).toBe("email");
    expect(actKindFor("message", "Instagram")).toBe("dm");
    expect(actKindFor("report", "TikTok")).toBeNull();
    expect(actKindFor("slideshows", undefined)).toBeNull();
  });
});

describe("slotWhyWords", () => {
  it("says the rule in words, on the app's clock", () => {
    expect(slotWhyWords("next", "post")).toBe("the next slot for this account");
    expect(slotWhyWords("account_day", "dm")).toBe("this account's 15 DMs for the day are taken");
    expect(slotWhyWords("window", "post")).toBe("Realm plans posts between 8 AM and 10 PM");
  });
});

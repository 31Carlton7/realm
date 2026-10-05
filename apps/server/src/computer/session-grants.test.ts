import { describe, expect, it } from "vitest";
import { ComputerSessionGrants } from "./session-grants";

/** The grant a mention makes: per session, per app, in memory, and never for an app no agent may drive. */
describe("computer use granted by a mention", () => {
  it("is held per session, in the order the apps were named, and says when it grew", () => {
    const g = new ComputerSessionGrants();
    expect(g.grant("s1", [{ bundleId: "com.apple.TextEdit", name: "TextEdit" }])).toBe(true);
    expect(g.grant("s1", [{ bundleId: "com.apple.TextEdit", name: "TextEdit" }])).toBe(false); // already granted: no re-list owed
    expect(g.grant("s1", [{ bundleId: "com.apple.mail", name: "Mail" }])).toBe(true);
    expect(g.apps("s1").map((a) => a.bundleId)).toEqual(["com.apple.TextEdit", "com.apple.mail"]);
    expect(g.apps("s2")).toEqual([]);
  });

  it("never grants an app no agent may drive, whatever the request says", () => {
    const g = new ComputerSessionGrants();
    expect(g.grant("s1", [{ bundleId: "com.apple.Terminal", name: "Terminal" }, { bundleId: "co.charmtechnologies.realm", name: "Realm" }])).toBe(false);
    expect(g.apps("s1")).toEqual([]);
  });

  it("is gone once the session is released — a resumed session has to be given it again", () => {
    const g = new ComputerSessionGrants();
    g.grant("s1", [{ bundleId: "com.apple.TextEdit", name: "TextEdit" }]);
    g.grant("s2", [{ bundleId: "com.apple.mail", name: "Mail" }]);
    g.release("s1");
    expect(g.apps("s1")).toEqual([]);
    expect(g.apps("s2").map((a) => a.name)).toEqual(["Mail"]);
  });
});

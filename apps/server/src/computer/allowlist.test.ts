import { describe, expect, it } from "vitest";
import { COMPUTER_FORBIDDEN_BUNDLE_IDS } from "@realm/contracts";
import { ComputerAppAllowlist } from "./allowlist";

/**
 * The durable list, over an in-memory settings table. What must die here: an entry leaking between
 * spaces, and — the one that matters — a forbidden bundle id being treated as allowed because it is
 * on the list.
 */
function allowlist(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed));
  const settings = {
    getIds: (key: string) => {
      const v = rows.get(key);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    },
    set: (key: string, value: unknown) => { rows.set(key, value); },
  };
  return { list: new ComputerAppAllowlist({ settings }), rows };
}

const FORBIDDEN_ID = COMPUTER_FORBIDDEN_BUNDLE_IDS[0];

describe("ComputerAppAllowlist", () => {
  it("is empty until the user puts something on it", () => {
    const { list } = allowlist();
    expect(list.list("sp1")).toEqual([]);
    expect(list.allows("sp1", "com.apple.TextEdit")).toBe(false);
  });

  it("remembers an app across calls", () => {
    const { list } = allowlist();
    list.add("sp1", "com.apple.TextEdit");
    expect(list.allows("sp1", "com.apple.TextEdit")).toBe(true);
    expect(list.list("sp1")).toEqual(["com.apple.TextEdit"]);
  });

  it("scopes an entry to its space", () => {
    const { list } = allowlist();
    list.add("sp1", "com.apple.TextEdit");
    expect(list.allows("sp2", "com.apple.TextEdit")).toBe(false);
    expect(list.list("sp2")).toEqual([]);
  });

  it("does not license a different app in the same space", () => {
    const { list } = allowlist();
    list.add("sp1", "com.apple.TextEdit");
    expect(list.allows("sp1", "com.apple.Mail")).toBe(false);
  });

  it("stores one sorted, de-duplicated row so the settings value stays diff-stable", () => {
    const { list, rows } = allowlist();
    expect(list.replace("sp1", ["com.apple.TextEdit", "com.apple.Mail", "com.apple.TextEdit"]))
      .toEqual(["com.apple.Mail", "com.apple.TextEdit"]);
    expect(rows.get("computer.allowedApps:sp1")).toEqual(["com.apple.Mail", "com.apple.TextEdit"]);
  });

  it("returns the list as stored, so a caller renders what is really in effect", () => {
    const { list } = allowlist();
    expect(list.replace("sp1", [FORBIDDEN_ID, "com.apple.TextEdit", "  "])).toEqual(["com.apple.TextEdit"]);
  });

  it("drops an entry the user removed", () => {
    const { list } = allowlist();
    list.replace("sp1", ["com.apple.TextEdit", "com.apple.Mail"]);
    list.replace("sp1", ["com.apple.Mail"]);
    expect(list.allows("sp1", "com.apple.TextEdit")).toBe(false);
  });
});

describe("the forbidden list beats the allowed list", () => {
  it("will not store a forbidden app, however it is offered", () => {
    const { list } = allowlist();
    list.add("sp1", FORBIDDEN_ID);
    expect(list.list("sp1")).toEqual([]);
    list.replace("sp1", [FORBIDDEN_ID]);
    expect(list.list("sp1")).toEqual([]);
  });

  it("refuses a forbidden app that is already in the settings row", () => {
    // The row is user-editable JSON on disk. A value that was never written through this class can
    // still be read through it, so the READ has to enforce the rule rather than trusting the write.
    for (const bundleId of COMPUTER_FORBIDDEN_BUNDLE_IDS) {
      const { list } = allowlist({ "computer.allowedApps:sp1": [bundleId, "com.apple.TextEdit"] });
      expect(list.allows("sp1", bundleId), bundleId).toBe(false);
      expect(list.list("sp1"), bundleId).toEqual(["com.apple.TextEdit"]);
    }
  });

  it("still allows the ordinary apps alongside a hand-added forbidden one", () => {
    const { list } = allowlist({ "computer.allowedApps:sp1": [FORBIDDEN_ID, "com.apple.TextEdit"] });
    expect(list.allows("sp1", "com.apple.TextEdit")).toBe(true);
  });

  it("treats a corrupt row as an empty list rather than throwing", () => {
    for (const value of [null, 42, "com.apple.TextEdit", { app: "x" }]) {
      const { list } = allowlist({ "computer.allowedApps:sp1": value });
      expect(list.list("sp1")).toEqual([]);
      expect(list.allows("sp1", "com.apple.TextEdit")).toBe(false);
    }
  });

  it("never allows an empty bundle id, which an app with no identifier would send", () => {
    const { list } = allowlist({ "computer.allowedApps:sp1": [""] });
    expect(list.allows("sp1", "")).toBe(false);
  });
});

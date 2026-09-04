import { describe, expect, it } from "vitest";
import { emptyLayout, gridPreset, type Layout } from "@realm/contracts";
import { item } from "../../state/store.test-fakes";
import { sessionForPick } from "./pick-target";

const sessionItem = (id: string, refId: string) => item(id, "s1", { kind: "session", refId, title: id });
const browserItem = () => item("ib", "s1", { kind: "browser", refId: "b1", title: "Browser" });
const twoUp = (a: string, b: string): Layout => gridPreset("two-col", [a, b]);
const leafFor = (l: Layout, itemId: string): string => {
  if (l.type === "leaf") return l.itemId === itemId ? l.id : "";
  return l.children.map((c) => leafFor(c, itemId)).find(Boolean) ?? "";
};

describe("sessionForPick", () => {
  it("sends to the only session open beside the browser", () => {
    const items = [sessionItem("i1", "se1"), browserItem()];
    expect(sessionForPick(items, twoUp("i1", "ib"), null)?.refId).toBe("se1");
  });

  it("prefers the session in the FOCUSED leaf when several are open", () => {
    const items = [sessionItem("i1", "se1"), sessionItem("i2", "se2")];
    const layout = twoUp("i1", "i2");
    expect(sessionForPick(items, layout, leafFor(layout, "i2"))?.refId).toBe("se2");
  });

  it("falls back to layout order when the focused leaf is the browser's own", () => {
    const items = [sessionItem("i1", "se1"), sessionItem("i2", "se2"), browserItem()];
    const layout = gridPreset("three-col", ["ib", "i1", "i2"]);
    expect(sessionForPick(items, layout, leafFor(layout, "ib"))?.refId).toBe("se1");
  });

  it("answers null when no session is open in the group, so the pane can say so", () => {
    expect(sessionForPick([browserItem()], twoUp("ib", "ib"), null)).toBeNull();
    expect(sessionForPick([sessionItem("i1", "se1")], emptyLayout(), null)).toBeNull();
    expect(sessionForPick([sessionItem("i1", "se1")], null, null)).toBeNull();
  });

  it("never reaches a session that exists but is not open in this layout", () => {
    const items = [sessionItem("i1", "se1"), browserItem()];
    expect(sessionForPick(items, twoUp("ib", "ib"), null)).toBeNull();
  });
});

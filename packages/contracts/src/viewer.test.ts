import { describe, expect, it } from "vitest";
import { ViewerInputSchema, ViewerOpenSchema } from "./viewer";

const at = { type: "pointer", x: 1, y: 2, width: 100, height: 100 } as const;

describe("ViewerInputSchema", () => {
  it("reads a bare move or wheel as no button, so a hover is not a drag", () => {
    expect(ViewerInputSchema.parse({ ...at, action: "move" })).toMatchObject({ action: "move", button: "none" });
    expect(ViewerInputSchema.parse({ ...at, action: "wheel", deltaY: 40 })).toMatchObject({ action: "wheel", button: "none" });
  });

  it("reads a bare press or release as the left button, and keeps a button that is named", () => {
    expect(ViewerInputSchema.parse({ ...at, action: "down" })).toMatchObject({ button: "left", clickCount: 1 });
    expect(ViewerInputSchema.parse({ ...at, action: "up" })).toMatchObject({ button: "left" });
    expect(ViewerInputSchema.parse({ ...at, action: "move", button: "left" })).toMatchObject({ button: "left" });
    expect(ViewerInputSchema.parse({ ...at, action: "down", button: "right" })).toMatchObject({ button: "right" });
  });

  it("still takes keys and text", () => {
    expect(ViewerInputSchema.parse({ type: "key", action: "down", key: "a" })).toMatchObject({ code: "", keyCode: 0, modifiers: 0 });
    expect(ViewerInputSchema.parse({ type: "text", text: "hi" })).toEqual({ type: "text", text: "hi" });
    expect(ViewerInputSchema.safeParse({ ...at, action: "hover" }).success).toBe(false);
  });
});

describe("ViewerOpenSchema", () => {
  it("opens by an app id and never by a port", () => {
    expect(ViewerOpenSchema.safeParse({ kind: "electron", cdpPort: 9222 }).success).toBe(false);
    const parsed = ViewerOpenSchema.parse({ kind: "electron", appId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cdpPort: 9222 });
    expect(parsed).not.toHaveProperty("cdpPort");
  });
});

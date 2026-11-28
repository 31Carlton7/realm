import { describe, expect, it } from "vitest";
import { decodeViewerFrame, encodeViewerFrame, ViewerInputSchema, ViewerLayoutSchema, ViewerOpenSchema } from "./viewer";

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

describe("ViewerInputSchema on a layer", () => {
  it("keeps the layer a pointer event names, with no viewer box needed", () => {
    expect(ViewerInputSchema.parse({ type: "pointer", layer: "C1", action: "down", x: 3, y: 4 })).toMatchObject({ layer: "C1", x: 3, y: 4, button: "left" });
    expect(ViewerInputSchema.parse({ type: "pointer", layer: "window", action: "move", x: 3, y: 4 })).toMatchObject({ layer: "window", button: "none" });
  });

  it("refuses a layer id that is not one, rather than routing it as a viewer point", () => {
    expect(ViewerInputSchema.safeParse({ ...at, action: "down", layer: "../x" }).success).toBe(false);
    expect(ViewerInputSchema.safeParse({ ...at, action: "down", layer: 7 }).success).toBe(false);
    expect(ViewerInputSchema.parse({ ...at, action: "down" })).not.toHaveProperty("layer");
  });
});

describe("layer frames", () => {
  it("round-trips a layer id and the JPEG's exact bytes", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]);
    const decoded = decodeViewerFrame(encodeViewerFrame("C1", jpeg));
    expect(decoded?.layer).toBe("C1");
    expect([...decoded!.jpeg]).toEqual([...jpeg]);
  });

  it("reads nothing that is not a frame", () => {
    expect(decodeViewerFrame(new Uint8Array([0]))).toBeNull();
    expect(decodeViewerFrame(new Uint8Array([0, 9, 1]))).toBeNull();
    const header = new TextEncoder().encode('{"type":"layout"}');
    expect(decodeViewerFrame(new Uint8Array([0, header.length, ...header]))).toBeNull();
    expect(() => encodeViewerFrame("no spaces", new Uint8Array())).toThrow();
  });

  it("describes a layout with the window at the bottom", () => {
    expect(ViewerLayoutSchema.parse({ type: "layout", layers: [{ id: "window", x: 0, y: 0, width: 800, height: 600, z: 0 }] }).layers).toHaveLength(1);
    expect(ViewerLayoutSchema.safeParse({ type: "layout", layers: [{ id: "window", x: 0, y: 0, width: -1, height: 600, z: 0 }] }).success).toBe(false);
  });
});

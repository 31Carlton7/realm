import { describe, expect, it } from "vitest";
import { axElementAt, readAxSnapshot, type AxSnapshot } from "./device-ax";
import { parsePickPoint } from "./browser-agent-host";

/**
 * The shape and the numbers are transcribed from a live `serve-sim` run against a booted iPhone 17
 * Pro on iOS 27 — a real Settings screen, in device points. Inventing a tidier fixture would test
 * arithmetic against itself; these are the frames the endpoint actually emits, floats and all.
 */
const SETTINGS: AxSnapshot = {
  screen: { width: 402, height: 874 },
  elements: [
    { id: "0.0", path: "0.0", label: "Settings", value: "", role: "heading", type: "Heading", enabled: true,
      frame: { x: 16, y: 119.66666666666667, width: 133, height: 40.66666666666667 } },
    // The group the rows live in, BEFORE them — which is the order `path` puts them in (0.1 precedes
    // 0.1.0), and the order that matters: a container that arrives first is what a "first containing
    // frame wins" implementation would return for every point inside it.
    { id: "group", path: "0.1", label: "", value: "", role: "group", type: "Other", enabled: true,
      frame: { x: 16, y: 168, width: 370, height: 400 } },
    { id: "com.apple.settings.primaryAppleAccount", path: "0.1.0", label: "Apple Account", value: "", role: "button", type: "Button", enabled: true,
      frame: { x: 16, y: 168, width: 370, height: 90.33333333333331 } },
    { id: "com.apple.settings.general", path: "0.1.1", label: "General", value: "", role: "button", type: "Button", enabled: true,
      frame: { x: 16, y: 293.3333333333333, width: 370, height: 44 } },
  ],
};

describe("axElementAt", () => {
  it("resolves the row the user pointed at, not the group containing it", () => {
    // General's centre: (16 + 370/2) / 402, (293.33 + 44/2) / 874.
    const hit = axElementAt(SETTINGS, 0.5, 0.3608)!;
    // THE MUTANT: take the first containing frame instead of the smallest. The group at 0.1 contains
    // every row, so every pick anywhere in Settings resolves to one unnamed "group" chip.
    expect(hit.id).toBe("com.apple.settings.general");
  });

  it("resolves a different row for a different point — the geometry is real", () => {
    expect(axElementAt(SETTINGS, 0.5, 0.24)!.id).toBe("com.apple.settings.primaryAppleAccount");
    expect(axElementAt(SETTINGS, 0.2, 0.16)!.id).toBe("0.0");
  });

  it("returns nothing for a point in empty screen, rather than the nearest thing", () => {
    // Bottom of the screen, below every frame. A chip for "whatever was closest" would name a
    // control the user did not point at.
    expect(axElementAt(SETTINGS, 0.5, 0.95)).toBeNull();
  });

  it("refuses points outside the surface", () => {
    for (const [x, y] of [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.01], [0.5, 1.01], [NaN, 0.5]]) {
      expect(axElementAt(SETTINGS, x!, y!), `${x},${y}`).toBeNull();
    }
  });

  it("skips zero-area frames, which would otherwise win every comparison", () => {
    const withGhost: AxSnapshot = { ...SETTINGS, elements: [
      { id: "ghost", path: "9", label: "", value: "", role: "other", type: "Other", enabled: true,
        frame: { x: 0, y: 0, width: 0, height: 0 } },
      ...SETTINGS.elements,
    ] };
    // A 0×0 frame at the origin does not contain the point, but one spanning the screen with zero
    // height would — and its area of 0 beats every real element.
    const flat: AxSnapshot = { ...withGhost, elements: [
      { id: "flat", path: "8", label: "", value: "", role: "other", type: "Other", enabled: true,
        frame: { x: 0, y: 0, width: 402, height: 0 } },
      ...SETTINGS.elements,
    ] };
    expect(axElementAt(flat, 0.5, 0.3608)!.id).toBe("com.apple.settings.general");
    expect(axElementAt(withGhost, 0.5, 0.3608)!.id).toBe("com.apple.settings.general");
  });
});

describe("readAxSnapshot", () => {
  const sse = (body: string) => ({
    ok: true,
    body: { getReader: () => {
      let sent = false;
      return {
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new TextEncoder().encode(body) })),
        cancel: async () => {},
      };
    } },
  }) as unknown as Response;

  const fetchOf = (res: Response | Error) => (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch;

  it("takes the first complete snapshot off the stream", async () => {
    const general = SETTINGS.elements.find((e) => e.id === "com.apple.settings.general")!;
    const line = JSON.stringify({ screen: { width: 402, height: 874 }, elements: [general] });
    const snap = await readAxSnapshot("http://127.0.0.1:3200", fetchOf(sse(`:\n\ndata: ${line}\n\n`)));
    expect(snap!.screen).toEqual({ width: 402, height: 874 });
    expect(snap!.elements[0]!.label).toBe("General");
  });

  it("returns null on a TRUNCATED line rather than a half-tree", async () => {
    // THE MUTANT: parse the buffer's tail without waiting for its newline. A pick would then resolve
    // against whichever elements survived the TCP segment boundary — wrong, and only sometimes.
    const line = JSON.stringify({ screen: { width: 402, height: 874 }, elements: SETTINGS.elements });
    expect(await readAxSnapshot("http://127.0.0.1:3200", fetchOf(sse(`data: ${line.slice(0, 120)}`)))).toBeNull();
  });

  it("is null for a page that serves no such endpoint, and for one that refuses", async () => {
    expect(await readAxSnapshot("http://example.test", fetchOf({ ok: false } as Response))).toBeNull();
    expect(await readAxSnapshot("http://example.test", fetchOf(new Error("ECONNREFUSED")))).toBeNull();
    // A 503 while the device's AX framework warms up after boot is the same answer: not now.
    expect(await readAxSnapshot("http://example.test", fetchOf({ ok: false, status: 503 } as Response))).toBeNull();
  });

  it("rejects a snapshot with no usable screen, which would make every normalized point meaningless", () => {
    return Promise.all([
      expect(readAxSnapshot("http://x.test", fetchOf(sse(`data: {"screen":{"width":0,"height":874},"elements":[]}\n`)))).resolves.toBeNull(),
      expect(readAxSnapshot("http://x.test", fetchOf(sse(`data: {"elements":[]}\n`)))).resolves.toBeNull(),
    ]);
  });
});

describe("parsePickPoint", () => {
  it("reads the point the picker sends, with the surface box when there is one", () => {
    expect(parsePickPoint(JSON.stringify({ x: 0.5, y: 0.25, surface: { x: 10, y: 20, w: 160, h: 348 } })))
      .toEqual({ x: 0.5, y: 0.25, surface: { x: 10, y: 20, w: 160, h: 348 } });
    // No surface under the pointer is the ordinary case: a plain page pick, and no device probe.
    expect(parsePickPoint(JSON.stringify({ x: 0.5, y: 0.25, surface: null })))
      .toEqual({ x: 0.5, y: 0.25, surface: null });
  });

  it("drops a zero-area surface, which a device frame would be divided by", () => {
    expect(parsePickPoint(JSON.stringify({ x: 0.5, y: 0.25, surface: { x: 0, y: 0, w: 0, h: 348 } })))
      .toEqual({ x: 0.5, y: 0.25, surface: null });
  });

  it("is null for the older payload, so a pane armed before an update still picks its DOM element", () => {
    expect(parsePickPoint("1")).toBeNull();
    expect(parsePickPoint("")).toBeNull();
  });

  it("drops a point outside the element rather than clamping it", () => {
    // Clamping would resolve a device pick to whatever sits at the screen's edge — a confident wrong
    // answer where null gives the honest one (the surface itself).
    expect(parsePickPoint(JSON.stringify({ x: 1.4, y: 0.5 }))).toBeNull();
    expect(parsePickPoint(JSON.stringify({ x: 0.5, y: -0.2 }))).toBeNull();
  });
});

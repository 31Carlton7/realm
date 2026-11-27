// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSnapshotElement } from "@realm/contracts";
import { HIGHLIGHT_ATTR, MARK_REFS, REMOVE_REF_BOXES_JS, refBoxes, refBoxesScript, refLegend, type CdpSend, type RefBox } from "./browser-agent";

const element = (ref: number, more: Partial<BrowserSnapshotElement> = {}): BrowserSnapshotElement => ({
  ref, role: "button", name: "", value: null, rect: { x: 0, y: 0, w: 0, h: 0 },
  checked: null, disabled: false, password: false, focused: false, offscreen: false, ...more,
});
const quad = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

afterEach(() => { document.documentElement.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((n) => n.remove()); document.body.innerHTML = ""; });

describe("the boxes an annotated screenshot draws", () => {
  it("places each box by its quads now, numbers only what the quads put on screen, in list order", async () => {
    const quads: Record<number, number[][]> = { 1: [quad(10, 10, 20, 10)], 2: [quad(40, 500, 32, 32)], 3: [quad(100, 50, 32, 32)], 4: [quad(900, 10, 10, 10)], 5: [] };
    const send: CdpSend = async (method, params) => (method === "DOM.getContentQuads" ? { quads: quads[params!.backendNodeId as number] } : {});
    const elements = [
      // THE MUTANT: placing a box by the snapshot's rect, which a 2× display reports in device pixels.
      element(1, { name: "Save", rect: { x: 20, y: 20, w: 40, h: 20 } }),
      // Flagged offscreen by a snapshot that read device pixels as CSS ones, but on screen.
      element(2, { offscreen: true, rect: { x: 80, y: 1000, w: 64, h: 64 } }),
      element(3, { role: "link", name: "Product 1" }),
      element(4),
      element(5),
    ];
    expect(await refBoxes(send, elements, { width: 800, height: 600 })).toEqual([
      { n: 1, ref: 1, role: "button", name: "Save", left: 10, top: 10, width: 20, height: 10 },
      { n: 2, ref: 2, role: "button", name: "", left: 40, top: 500, width: 32, height: 32 },
      { n: 3, ref: 3, role: "link", name: "Product 1", left: 100, top: 50, width: 32, height: 32 },
    ]);
  });

  it("writes one legend line a box, naming refs as the snapshot does", () => {
    const boxes: RefBox[] = [
      { n: 1, ref: 812, role: "button", name: "", left: 0, top: 0, width: 1, height: 1 },
      { n: 2, ref: 813, role: "link", name: "Product 2", left: 0, top: 0, width: 1, height: 1 },
    ];
    expect(refLegend(boxes)).toBe('[1] ref=812 button\n[2] ref=813 link "Product 2"');
  });

  it("is gone from the page once removed, and the page could not read the boxes meanwhile", async () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const before = document.documentElement.outerHTML;
    const box: RefBox = { n: 7, ref: 1, role: "button", name: "Go", left: 4, top: 30, width: 40, height: 20 };
    expect(await (0, eval)(refBoxesScript([box], "rgb(76, 141, 255)"))).toBe(true);
    const host = document.querySelector(`[${HIGHLIGHT_ATTR}="${MARK_REFS}"]`) as HTMLElement;
    expect(host).not.toBeNull();
    // Closed: the page's own scripts see one empty element, not the boxes or their numbers.
    expect(host.shadowRoot).toBeNull();
    expect(host.textContent).toBe("");
    expect(document.body.textContent).toBe("Go");
    // THE MUTANT: leaving the removal out, and the boxes stay on the page.
    (0, eval)(REMOVE_REF_BOXES_JS);
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it("puts nothing of the page's into the script", () => {
    const box: RefBox = { n: 1, ref: 1, role: "button", name: "</script><img src=x onerror=alert(1)>", left: 0, top: 0, width: 1, height: 1 };
    expect(refBoxesScript([box], "red")).not.toContain("onerror");
  });
});

// @vitest-environment jsdom
import { isSecretField } from "@realm/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { CdpSend } from "./browser-agent";
import { bothReads, COVER_MARGIN, coverFields, fitWithin, isSecretFields, pageFields, readSecretRects, SECRET_FIELDS, type SecretFields } from "./phone-frame";

/**
 * What a phone is never shown of a page. What must die: a password field's dots, or its text after a
 * page's "Show password", in a picture that crosses a cellular link to a phone; and a field the rule
 * names but whose cover lands somewhere else in the picture.
 */

const found = (): SecretFields => (0, eval)(SECRET_FIELDS) as SecretFields;

/** jsdom has no layout: each field is placed where the test says. */
function place(selector: string, rect: { left: number; top: number; width: number; height: number }, root: ParentNode = document): void {
  const el = root.querySelector(selector) as HTMLElement;
  el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("the fields a phone is not shown", () => {
  it("finds a password field, a one-time code and a card's number and code, and leaves the rest", () => {
    document.body.innerHTML = `
      <input id="user" name="email" autocomplete="username">
      <input id="pw" type="password">
      <input id="shown" type="text" name="password">
      <input id="otp" autocomplete="one-time-code">
      <input id="card" autocomplete="cc-number">
      <input id="cvc" name="cvc">
      <input id="search" type="search">
      <input id="remember" type="checkbox" name="remember-password">`;
    for (const [i, id] of ["user", "pw", "shown", "otp", "card", "cvc", "search", "remember"].entries()) place(`#${id}`, { left: 10, top: 10 + i * 40, width: 200, height: 30 });
    // THE MUTANT: `type=password` alone — a page's "Show password" turns the field to text, and a phone reads it.
    expect(found().rects.map(([, y]) => (y - 10) / 40)).toEqual([1, 2, 3, 4, 5]);
    // The page script and the agent's page read hide the same fields.
    const typed = [...document.querySelectorAll("input")].filter((el) => el.type !== "checkbox");
    expect(typed.filter((el) => isSecretField({ type: el.getAttribute("type"), name: el.getAttribute("name"), id: el.id, autocomplete: el.getAttribute("autocomplete") })).map((el) => el.id))
      .toEqual(["pw", "shown", "otp", "card", "cvc"]);
  });

  it("finds each box of a code row and a field named for a code", () => {
    // THE MUTANT: `isSecretField`'s words alone — the boxes past the first say nothing but maxlength=1.
    document.body.innerHTML = `<div>${Array.from({ length: 6 }, (_, i) => `<input maxlength="1"${i === 0 ? ' autocomplete="one-time-code"' : ""}>`).join("")}</div><input name="verificationCode"><input name="promo_code">`;
    document.querySelectorAll("input").forEach((el, i) => { el.getBoundingClientRect = () => ({ left: i * 50, top: 0, width: 40, height: 40, right: i * 50 + 40, bottom: 40, x: i * 50, y: 0, toJSON: () => ({}) }) as DOMRect; });
    expect(found().rects.map(([x]) => x / 50)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("finds one inside an open shadow root", () => {
    document.body.innerHTML = `<sign-in></sign-in>`;
    const shadow = document.querySelector("sign-in")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input type="password">`;
    place("input", { left: 0, top: 0, width: 100, height: 20 }, shadow);
    expect(found().rects).toEqual([[0, 0, 100, 20]]);
  });

  it("leaves out a field with no size, and one wholly off the viewport", () => {
    document.body.innerHTML = `<input id="a" type="password"><input id="b" type="password">`;
    place("#a", { left: 0, top: 0, width: 0, height: 0 });
    place("#b", { left: 0, top: innerHeight + 50, width: 100, height: 20 });
    expect(found().rects).toEqual([]);
  });

  it("places a field Realm filled, whatever it now says about itself, for an agent's screenshot", async () => {
    // THE MUTANT: the filled refs not passed to the page script — a code field that names itself
    // nothing a code field does is left in the picture.
    document.body.innerHTML = `<input id="box" value="482913"><input id="user" name="email">`;
    place("#box", { left: 10, top: 20, width: 120, height: 40 });
    place("#user", { left: 10, top: 80, width: 120, height: 40 });
    const nodes: Record<string, Element> = { "obj-7": document.getElementById("box")! };
    const send = (async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
      if (method === "Runtime.callFunctionOn") {
        const fn = (0, eval)(`(${String(params.functionDeclaration)})`) as (...a: unknown[]) => unknown;
        return { result: { value: fn.apply(nodes[String(params.objectId)], (params.arguments as { objectId: string }[]).map((a) => nodes[a.objectId])) } };
      }
      if (method === "Runtime.evaluate") return { result: { value: (0, eval)(String(params.expression)) } };
      return {};
    }) as unknown as CdpSend;
    expect((await readSecretRects(send, [7]))?.rects).toEqual([[10, 20, 120, 40]]);
    expect((await readSecretRects(send, []))?.rects).toEqual([]);
    expect(await readSecretRects((async () => ({ result: { value: "not mine" } })) as unknown as CdpSend, [])).toBeNull();
  });

  it("takes only an answer of its own shape: a page that replaced the globals gets no picture", () => {
    expect(isSecretFields({ vw: 800, vh: 600, rects: [[1, 2, 3, 4]] })).toBe(true);
    expect(isSecretFields({ vw: 800, vh: 600, rects: [[1, 2, 3]] })).toBe(false);
    expect(isSecretFields({ vw: 800, vh: 600, rects: [[1, 2, 3, Number.NaN]] })).toBe(false);
    expect(isSecretFields("nothing here")).toBe(false);
    expect(isSecretFields(null)).toBe(false);
  });
});

describe("whether a page is pictured", () => {
  const top: SecretFields = { vw: 800, vh: 600, rects: [[10, 20, 200, 30]] };
  const empty: SecretFields = { vw: 300, vh: 150, rects: [] };

  it("covers the top frame's fields, and frames below with none, or with no document yet, change nothing", () => {
    expect(pageFields(top, [empty, null])).toBe(top);
  });

  it("is not pictured when the top frame did not answer as itself", () => {
    // THE MUTANT: a top frame that could not be read pictured with nothing covered.
    expect(pageFields(null, [])).toBeNull();
    expect(pageFields("late", [])).toBeNull();
  });

  it("is not pictured while a frame below holds a secret field, or answered late or as something else", () => {
    expect(pageFields(top, [{ vw: 300, vh: 150, rects: [[0, 0, 100, 20]] }])).toBeNull();
    expect(pageFields(top, ["late"])).toBeNull();
    expect(pageFields(top, [{ nothing: true }])).toBeNull();
  });

  it("covers a field where it was before the picture and where it was after, for a page that scrolled", () => {
    const after: SecretFields = { vw: 800, vh: 600, rects: [[10, -80, 200, 30]] };
    // THE MUTANT: the first read alone — the page scrolled, and the field is drawn where no cover is.
    expect(bothReads(top, after)?.rects).toEqual([[10, 20, 200, 30], [10, -80, 200, 30]]);
    expect(bothReads(top, null)).toBeNull();
  });
});

describe("the cover", () => {
  /** A white BGRA bitmap. */
  const white = (w: number, h: number) => new Uint8Array(w * h * 4).fill(0xff);
  const pixel = (b: Uint8Array, w: number, x: number, y: number) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

  it("paints the field's place, a little past its edges, at the bitmap's own scale", () => {
    // An 800-px-wide viewport pictured at 400 px: every CSS pixel is half a pixel of the bitmap.
    const b = white(400, 300);
    coverFields(b, 400, 300, { vw: 800, vh: 600, rects: [[100, 100, 200, 40]] });
    const grey = [0x8a, 0x8a, 0x8a, 0xff];
    // THE MUTANT: the field's CSS pixels used as the bitmap's — a cover over the wrong part of the page.
    expect(pixel(b, 400, 50, 50)).toEqual(grey);
    expect(pixel(b, 400, 149, 69)).toEqual(grey);
    expect(pixel(b, 400, 50 - COVER_MARGIN / 2, 50)).toEqual(grey);
    expect(pixel(b, 400, 160, 50)).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(pixel(b, 400, 100, 100)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("stays inside the bitmap for a field that runs off its edge", () => {
    const b = white(100, 100);
    expect(() => coverFields(b, 100, 100, { vw: 100, vh: 100, rects: [[-20, 90, 200, 50]] })).not.toThrow();
    expect(b.length).toBe(100 * 100 * 4);
    expect(pixel(b, 100, 99, 99)).toEqual([0x8a, 0x8a, 0x8a, 0xff]);
  });

  it("fits a picture within the side asked for, and never enlarges one", () => {
    expect(fitWithin(1600, 1000, 1000)).toEqual({ width: 1000, height: 625 });
    expect(fitWithin(600, 400, 1000)).toEqual({ width: 600, height: 400 });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { panelShapes } from "./quick-chat-panel-frame";

/** A shape laid out at a rect: jsdom has no layout, so each one says where it is. */
function shape(className: string, rect: { x: number; y: number; width: number; height: number }, parent: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.getBoundingClientRect = () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect }) as DOMRect;
  parent.appendChild(el);
  return el;
}

function panel() {
  const root = document.createElement("section");
  document.body.appendChild(root);
  return root;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("the shapes the panel's material is cut to", () => {
  it("are the answer and the toolbar, top to bottom, each a capsule", () => {
    const root = panel();
    shape("quick-chat-answer", { x: 16, y: 20, width: 330, height: 56 }, root);
    const foot = shape("quick-chat-foot", { x: 16, y: 84, width: 330, height: 40 }, root);
    shape("quick-chat-tools", { x: 234, y: 84, width: 112, height: 40 }, foot);
    expect(panelShapes(root)).toEqual([
      { x: 16, y: 20, width: 330, height: 56, radius: 28, squircle: false, alpha: 1 },
      { x: 234, y: 84, width: 112, height: 40, radius: 20, squircle: false, alpha: 1 },
    ]);
  });

  it("give the card the card rung on the painter's curve, and the bar its capsule", () => {
    const root = panel();
    shape("quick-chat-card", { x: 16, y: 16, width: 330, height: 300 }, root);
    const foot = shape("quick-chat-foot", { x: 16, y: 324, width: 330, height: 40 }, root);
    shape("composer", { x: 16, y: 324, width: 330, height: 40 }, foot);
    const [card, bar] = panelShapes(root);
    expect(card).toMatchObject({ radius: 20, squircle: true });
    expect(bar).toMatchObject({ x: 16, width: 330, radius: 20, squircle: false });
  });

  it("leave out a shape that is not laid out", () => {
    const root = panel();
    shape("quick-chat-card", { x: 0, y: 0, width: 0, height: 0 }, root);
    expect(panelShapes(root)).toEqual([]);
  });

  it("show only their right end at the start of the way in, and widen to the whole shape", () => {
    const root = panel();
    const foot = shape("quick-chat-foot", { x: 16, y: 16, width: 330, height: 40 }, root);
    shape("composer", { x: 16, y: 16, width: 330, height: 40 }, foot);
    expect(panelShapes(root, 0)[0]).toMatchObject({ x: 226, width: 120, alpha: 0.4 });
    expect(panelShapes(root, 0.5)[0]).toMatchObject({ x: 121, width: 225, alpha: 0.7 });
    expect(panelShapes(root, 1)[0]).toMatchObject({ x: 16, width: 330, alpha: 1 });
  });

  it("fade to nothing on the way out, narrowing into the same right end", () => {
    const root = panel();
    const foot = shape("quick-chat-foot", { x: 16, y: 16, width: 330, height: 40 }, root);
    shape("composer", { x: 16, y: 16, width: 330, height: 40 }, foot);
    expect(panelShapes(root, 0, true)[0]).toMatchObject({ x: 226, width: 120, alpha: 0 });
  });

  it("never widen a shape narrower than the reveal past its own width", () => {
    const root = panel();
    const foot = shape("quick-chat-foot", { x: 0, y: 0, width: 330, height: 40 }, root);
    shape("quick-chat-tools", { x: 234, y: 0, width: 112, height: 40 }, foot);
    expect(panelShapes(root, 0)[0]).toMatchObject({ x: 234, width: 112 });
  });
});

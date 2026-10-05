import { describe, expect, it } from "vitest";
import { diagramName, sanitizeDiagram, scrubCss } from "./mermaid";

/**
 * The gate between Mermaid's drawing and the window. Mermaid is a large parser fed agent text, so its
 * output is held to what Realm draws rather than trusted: whatever a diagram's text manages to make it
 * emit, what reaches the DOM links nowhere, fetches nothing, runs nothing and holds still.
 */

const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="rlmmdsvg" viewBox="0 0 200 100">${inner}</svg>`;
const clean = (inner: string) => sanitizeDiagram(svg(inner))!.outerHTML;

describe("sanitizeDiagram — what a diagram may put on screen", () => {
  it("keeps the drawing itself: shapes, text, markers, the diagram's own style", () => {
    const out = clean('<style>#rlmmdsvg .node rect{fill:#333;}</style><defs><marker id="rlmmdsvg_end"><path d="M0,0L10,5"/></marker></defs>'
      + '<g class="node"><rect width="40" height="20"/><text x="4" y="14">Sign in</text></g><path d="M0,0L50,50" marker-end="url(#rlmmdsvg_end)"/>');
    expect(out).toContain("<rect");
    expect(out).toContain(">Sign in</text>");
    expect(out).toContain('marker-end="url(#rlmmdsvg_end)"');
    expect(out).toContain("#rlmmdsvg .node rect{fill:#333;}");
  });

  it("strips a script, an event handler and a javascript: link", () => {
    // THE MUTANT: hand the SVG profile nothing to forbid, and the link survives as a clickable one.
    const out = clean('<script>alert(1)</script><g onclick="alert(2)" onload="alert(3)"><a xlink:href="javascript:alert(4)" href="javascript:alert(5)"><text>Click me</text></a></g>');
    expect(out).not.toMatch(/<script|alert|onclick|onload|javascript:|<a\b/i);
    // A linked node is still a node: the label stays, as text.
    expect(out).toContain(">Click me</text>");
  });

  it("turns a link into a plain group — a diagram's links are not Realm's to follow, and its node stays put", () => {
    // THE MUTANT: drop the link around its content instead, and Mermaid's linked node loses the
    // position it carries on the `<a>` — it is drawn at the origin, over the top of the diagram.
    const out = clean('<a href="https://example.com/x" target="_blank" transform="translate(96, 32.5)" class="node-link"><g class="node"><text>Docs</text></g></a>');
    expect(out).not.toMatch(/<a\b|example\.com|target=/);
    expect(out).toContain('<g transform="translate(96, 32.5)" class="node-link"><g class="node"><text>Docs</text></g></g>');
  });

  it("takes away the hand Mermaid's sheet gives a node it thinks is clickable", () => {
    expect(clean('<g class="node default clickable" id="n"><text>B</text></g>')).toContain('<g class="node default" id="n">');
  });

  it("removes what would fetch: pictures, embedded HTML, external uses and filter images", () => {
    const out = clean('<image href="https://example.com/x.png" width="10" height="10"/><foreignObject width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://example.com/y.png"/>html</div></foreignObject>'
      + '<use href="https://example.com/sprite.svg#icon"/><filter id="f"><feImage href="https://example.com/z.png"/></filter>');
    expect(out).not.toMatch(/example\.com|<image|<foreignobject|<use|<feimage|<img|html<\/div>/i);
  });

  it("cuts every reference out of the drawing, in attributes and in style, and keeps the ones into it", () => {
    const out = clean('<rect fill="url(https://example.com/p.svg#g)" filter="url(#rlmmdsvg-shadow)" style="background:url(\'https://example.com/b.png\');fill:red"/>'
      + '<rect style="background:u\\72l(https://example.com/escaped.png)"/><rect style="background:u\\5c 72l(https://example.com/twice.png)"/>');
    expect(out).not.toContain("example.com");
    expect(out).toContain('filter="url(#rlmmdsvg-shadow)"');
    expect(out).toContain("fill:red");
  });

  it("drops a stylesheet's imports, fonts and animations — nothing loads and nothing loops", () => {
    // THE MUTANT: skip the style element, and `@import` fetches a stylesheet from anywhere the
    // diagram's text could get Mermaid to name.
    const out = clean('<style>@import url(https://example.com/x.css); @font-face{font-family:x;src:url(https://example.com/f.woff2)}'
      + '@keyframes dash{0%{stroke-dashoffset:9}100%{stroke-dashoffset:0}} .edge{animation:dash 2s linear infinite;stroke:#999} .n{fill:url( "https://example.com/p" )}</style>');
    expect(out).not.toMatch(/@import|@font-face|@keyframes|animation|example\.com/);
    expect(out).toContain("stroke:#999");
  });

  it("answers null for markup with nothing drawable left in it", () => {
    expect(sanitizeDiagram("<script>alert(1)</script>")).toBeNull();
    expect(sanitizeDiagram("<div>not a drawing</div>")).toBeNull();
  });
});

describe("scrubCss", () => {
  it("keeps a reference into the drawing and nothing that leaves it", () => {
    expect(scrubCss("marker-end:url(#a);fill:url('#b')")).toBe("marker-end:url(#a);fill:url('#b')");
    expect(scrubCss("fill:url(//example.com/p)")).toBe("fill:none");
    expect(scrubCss("background:image-set('a.png' 1x)")).toBe("background:none");
  });
});

describe("diagramName", () => {
  it("names the kinds of diagram Mermaid reports, and says Diagram for the rest", () => {
    expect(diagramName("sequence")).toBe("Sequence diagram");
    expect(diagramName("flowchart-v2")).toBe("Flowchart");
    expect(diagramName("architecture-beta")).toBe("Architecture diagram");
    expect(diagramName("zenuml")).toBe("Diagram");
  });
});

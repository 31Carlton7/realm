/**
 * A drawn block, copied: as a picture, as an SVG a design tool can open, or as the text it came from.
 *
 * The picture is the block redrawn off screen rather than a capture of the screen, so it is the whole
 * block whatever is scrolled or laid over it — a tooltip, the prompter. Every computed style is
 * written onto a copy of the block and the copy is drawn as an SVG `foreignObject` into a canvas; the
 * fonts go with it, because an SVG drawn as an image can see the system's fonts and none of the
 * document's, and Inter is the document's.
 */

/** Copied as computed values, not as rules: these would only make the picture move or point. */
const SKIP = /^(?:--|transition|animation|cursor|pointer-events|will-change|view-transition|caret)/;

function inline(src: Element, keepOwnStyles: (el: Element) => boolean): Element {
  const out = src.cloneNode(false) as Element;
  const view = src.ownerDocument.defaultView;
  if (view && (out instanceof HTMLElement || out instanceof SVGElement) && !keepOwnStyles(src)) {
    const cs = view.getComputedStyle(src);
    for (let i = 0; i < cs.length; i++) {
      const p = cs.item(i);
      if (!SKIP.test(p)) out.style.setProperty(p, cs.getPropertyValue(p));
    }
  }
  for (const child of Array.from(src.childNodes)) {
    if (child instanceof Element) {
      // A drawing that styles itself (a diagram's own `<style>`) is copied as it is; its root still
      // takes the size the block gave it.
      out.appendChild(keepOwnStyles(child) ? sized(child) : inline(child, keepOwnStyles));
    } else out.appendChild(child.cloneNode(true));
  }
  return out;
}

function sized(el: Element): Element {
  const out = el.cloneNode(true) as SVGElement;
  const r = el.getBoundingClientRect();
  out.setAttribute("width", String(Math.round(r.width)));
  out.setAttribute("height", String(Math.round(r.height)));
  return out;
}

/** Inter, and any family the person downloaded, as `@font-face` rules an image can resolve. Inter is
 *  a chunk of its own, loaded the first time anything is copied as a picture. */
async function fontFaces(): Promise<string> {
  const { default: inter } = await import("../../../assets/fonts/InterVariable.woff2?inline");
  const downloaded = document.getElementById("realm-installed-fonts")?.textContent ?? "";
  return `@font-face{font-family:"Inter";font-weight:100 900;font-style:normal;src:url(${inter}) format("woff2")}${downloaded}`;
}

/**
 * `el` as a PNG at twice its size, on `ground` — the block's own fill, which is painted by the
 * squircle worklet on screen and has to be stated for a picture. `omit` names what the copy leaves
 * out (the block's own buttons).
 */
export async function blockPicture(el: HTMLElement, ground: string, omit = ".ui-block-acts"): Promise<Blob> {
  const { width, height } = el.getBoundingClientRect();
  const w = Math.ceil(width), h = Math.ceil(height);
  const copy = inline(el, (e) => e.matches(".ui-diagram svg")) as HTMLElement;
  for (const gone of Array.from(copy.querySelectorAll(omit))) gone.remove();
  Object.assign(copy.style, { margin: "0", background: ground, borderRadius: "16px", width: `${w}px`, height: `${h}px` });
  const body = new XMLSerializer().serializeToString(copy);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><style>${await fontFaces()}</style>` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${body}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas to draw the picture on");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the picture did not encode"))), "image/png"));
}

/** A chart's SVG on its own: every style it reads from the app's sheet written onto it, its ground
 *  stated, so it opens the same in a tool that has never seen the app. */
export function chartSvg(svg: SVGSVGElement, ground: string): string {
  const copy = inline(svg, () => false) as SVGSVGElement;
  const { width, height } = svg.getBoundingClientRect();
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(Math.round(width)));
  copy.setAttribute("height", String(Math.round(height)));
  copy.removeAttribute("class");
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", ground);
  copy.insertBefore(bg, copy.firstChild);
  return new XMLSerializer().serializeToString(copy);
}

/** A diagram's SVG, which already carries its own styles: its ground and its namespace stated. */
export function diagramSvg(markup: string, ground: string): string {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = doc.documentElement;
  const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb[2] && vb[3]) { svg.setAttribute("width", String(vb[2])); svg.setAttribute("height", String(vb[3])); }
  const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(vb[0] ?? 0));
  bg.setAttribute("y", String(vb[1] ?? 0));
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", ground);
  svg.insertBefore(bg, svg.firstChild);
  return new XMLSerializer().serializeToString(svg);
}

/** Put an SVG on the clipboard as its markup — which is what a design tool reads a pasted SVG as —
 *  and as an SVG image where the clipboard takes one. */
export async function copySvg(markup: string): Promise<void> {
  const text = new Blob([markup], { type: "text/plain" });
  const items: Record<string, Blob> = { "text/plain": text };
  if (typeof ClipboardItem.supports === "function" && ClipboardItem.supports("image/svg+xml")) items["image/svg+xml"] = new Blob([markup], { type: "image/svg+xml" });
  await navigator.clipboard.write([new ClipboardItem(items)]);
}

/** The picture is drawn while the clipboard waits for it, so the write starts inside the click. */
export async function copyPicture(picture: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": picture })]);
}

/** A table as text and as HTML, so it pastes as a table wherever one can be pasted. */
export async function copyTable(markdown: string, html: string): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({
    "text/plain": new Blob([markdown], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }),
  })]);
}

import { basenameOf } from "@realm/contracts";
import type { Mark } from "../../state/viewer";
import type { Size } from "./zoom";

/**
 * Marks drawn over a picture in the viewer, made into a picture of their own: the file as macOS
 * renders it for a page, with the marks laid over it — what goes beside the file on the next
 * question, so the agent sees what was circled rather than reading where.
 *
 * Drawn from Quick Look's render (`files.preview`, a data URL), never from the `realm-media://` frame
 * on the stage: a canvas that draws a picture from another origin is tainted and will not give its
 * pixels back, and the media scheme is another origin by design.
 */

/** How wide a mark looks on screen while it is drawn, in CSS pixels. Stored in the picture's own
 *  pixels (`Mark.width`), so a mark drawn zoomed in is a fine line and one drawn at fit a bold one. */
export const MARK_SCREEN_WIDTH = 3;

/** The ink: the theme's red, as the stylesheet resolves it, so the composed picture says what the
 *  stage said. The fallback is Apple's system red, the colour every Mac markup tool draws with. */
export function markInk(): string {
  if (typeof document === "undefined") return "#ff3b30";
  return getComputedStyle(document.documentElement).getPropertyValue("--rl-danger").trim() || "#ff3b30";
}

/** `hero.png` → `hero-marked.png`: the copy's name says what it is and which file it is of. */
export function markedName(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}-marked.png`;
}

/** An SVG/canvas polyline's points, as the `points` attribute takes them. */
export const pointsAttr = (m: Mark): string => m.points.map(([x, y]) => `${x},${y}`).join(" ");

/**
 * The marked copy, as a File the prompter's paste path writes out and attaches like any picture;
 * null when there is no render of the file to draw on (no bridge, no Quick Look generator) or the
 * canvas will not draw. `natural` is the size the marks were drawn against.
 */
export async function composeMarks(path: string, natural: Size, marks: readonly Mark[]): Promise<File | null> {
  if (marks.length === 0 || natural.w <= 0) return null;
  const url = await (window.realm?.files?.preview?.(path, "page") ?? Promise.resolve(null)).catch(() => null);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { return null; }
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  // The render is a resize of the file, so the marks are carried across by the same factor.
  const k = img.naturalWidth / natural.w;
  ctx.strokeStyle = markInk();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const m of marks) {
    const [first, ...rest] = m.points;
    if (!first) continue;
    ctx.lineWidth = m.width * k;
    ctx.beginPath();
    ctx.moveTo(first[0] * k, first[1] * k);
    // A tap is a dot: a line to itself, which a round cap draws as one.
    for (const [x, y] of rest.length > 0 ? rest : [first]) ctx.lineTo(x * k, y * k);
    ctx.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new File([blob], markedName(path), { type: "image/png" }) : null;
}

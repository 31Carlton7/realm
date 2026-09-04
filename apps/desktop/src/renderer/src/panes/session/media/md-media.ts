import type { MarkedExtension, Tokens } from "marked";
import { isPlayablePath } from "@realm/contracts";

/**
 * `![shot](/tmp/render.png)` and `[the clip](~/out/clip.mp4)`, as media rather than as a broken
 * image and a dead link.
 *
 * Both used to fail silently and for different reasons: an `<img src="/tmp/render.png">` resolves
 * against the app bundle and 404s, and a `file://` href does not survive DOMPurify's URI allowlist
 * at all. So an agent that did the most obvious thing — embed the picture it just made — got less
 * than one that merely named the file.
 *
 * The path never travels through the sanitizer as a URL. It is parked in a `data-` attribute on an
 * empty span, and the Markdown component renders a real player into that span AFTER main has
 * confirmed the file exists. That ordering is the point: markdown here is agent output, and the one
 * thing it must not be able to do is name a URL the renderer then fetches.
 */

/** Paths worth parking: absolute, home-relative, explicitly relative, or a `file://` URL. A bare
 *  `shot.png` is NOT one — relative to the app bundle it means nothing, and guessing a base would
 *  be inventing a file. Returns the path, or null for an ordinary href (http, an anchor, a mailto). */
export function localMediaHref(href: string): string | null {
  let path = href;
  if (path.startsWith("file://")) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return null; }
  } else if (!/^(?:[/~]|\.{1,2}\/)/.test(path)) return null;
  return isPlayablePath(path) ? path : null;
}

/** Attribute-safe: this string is interpolated into markup, and a filename may legitimately contain
 *  a quote or an angle bracket. Ampersand first, or it would double-escape the others' entities. */
const attr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The placeholder the Markdown component fills in. A `<span>` on purpose: it is phrasing content,
 *  so it is valid where marked put it (inside a `<p>`) and survives the parse/serialize round trip
 *  that `decorate` and `dangerouslySetInnerHTML` put the document through. A `<figure>` there would
 *  be hoisted out of its paragraph and lose its place in the prose. */
const placeholder = (path: string, alt: string): string =>
  `<span class="md-media-ref" data-media-path="${attr(path)}" data-media-alt="${attr(alt)}"></span>`;

/* marked's documented fall-through: a renderer override that returns `false` defers to the one it
 * replaced. The published types say these return `string`, so the two overrides below are typed as
 * returning it and the `false` is cast at the one place it is produced — the alternative is
 * reimplementing marked's own `<img>` and `<a>` markup, escaping included, to hand back unchanged. */
const DEFER = false as unknown as string;

export const mediaExtension: MarkedExtension = {
  renderer: {
    image({ href, text }: Tokens.Image): string {
      const path = localMediaHref(href);
      return path ? placeholder(path, text) : DEFER;
    },
    link({ href, text }: Tokens.Link): string {
      const path = localMediaHref(href);
      // A link's text is a caption the author wrote; an image's alt may well be empty. Either way
      // the alt is only a fallback — the file's own name is what the frame labels it with.
      return path ? placeholder(path, text) : DEFER;
    },
  },
};

/** The parked paths in a rendered document, in order. Read back off the DOM rather than re-lexed
 *  from the markdown, so there is exactly one definition of what counts as an embed. */
export function mediaRefsIn(root: ParentNode): { path: string; el: HTMLElement }[] {
  const out: { path: string; el: HTMLElement }[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".md-media-ref"))) {
    const path = el.dataset["mediaPath"];
    if (path) out.push({ path, el });
  }
  return out;
}

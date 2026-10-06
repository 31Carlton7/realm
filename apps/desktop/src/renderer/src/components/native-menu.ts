/** Helpers that turn a rendered `Menu` row into what an OS menu can draw (main/native-menu.ts). */

const MODIFIERS: Record<string, string> = { "⌘": "Command", "⇧": "Shift", "⌥": "Alt", "⌃": "Control" };
const NAMED_KEYS: Record<string, string> = {
  "⏎": "Return", "↩": "Return", "⌫": "Backspace", "⌦": "Delete", "⎋": "Escape", "⇥": "Tab",
  "←": "Left", "→": "Right", "↑": "Up", "↓": "Down", Space: "Space",
};

/**
 * A row's shortcut HINT ("⌘⇧F") as an Electron accelerator ("Command+Shift+F"), so the OS menu
 * right-aligns it in the system's own glyphs. Display only — main passes `registerAccelerator: false`
 * and the binding stays in hotkeys.ts. A hint this cannot read is dropped rather than guessed: a
 * wrong shortcut printed on a menu is worse than none.
 */
export function acceleratorFor(hint: string): string | undefined {
  const mods: string[] = [];
  let rest = hint;
  while (rest.length > 0 && MODIFIERS[rest[0]!]) { mods.push(MODIFIERS[rest[0]!]!); rest = rest.slice(1); }
  const key = NAMED_KEYS[rest]
    ?? (/^[A-Za-z0-9]$/.test(rest) ? rest.toUpperCase() : undefined)
    ?? (/^F([1-9]|1[0-9]|2[0-4])$/.test(rest) ? rest : undefined)
    ?? (/^[\\/,.;'[\]=`-]$/.test(rest) ? rest : undefined);
  return key ? [...mods, key].join("+") : undefined;
}

/**
 * A row's label as one line of text. Labels are React nodes — "Mode" beside the current mode's chip,
 * a connector's name beside its health — and an OS menu takes a string, so each separate run of text
 * becomes a part, joined the way a Mac menu joins a name to its detail.
 */
export function menuLabelText(el: Element): string {
  const parts: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.replace(/\s+/g, " ").trim();
    if (t) parts.push(t);
  }
  return parts.join(" — ");
}

const iconCache = new Map<string, Promise<string | undefined>>();

/**
 * A row's glyph as a 32px PNG — 16pt at 2x — in black on transparent, for main to mark as a template
 * image so the menu draws it in its own ink. The icon set strokes in `currentColor`, so stating the
 * colour on the root is all it takes to make the SVG stand alone outside the document.
 */
export function rasteriseIcon(svg: SVGSVGElement): Promise<string | undefined> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", "32");
  copy.setAttribute("height", "32");
  copy.setAttribute("style", "color:#000");
  copy.removeAttribute("class");
  const markup = new XMLSerializer().serializeToString(copy);
  let pending = iconCache.get(markup);
  if (!pending) {
    pending = new Promise<string | undefined>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 32;
          const g = canvas.getContext("2d");
          if (!g) return resolve(undefined);
          g.drawImage(img, 0, 0, 32, 32);
          resolve(canvas.toDataURL("image/png"));
        } catch { resolve(undefined); }
      };
      img.onerror = () => resolve(undefined);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    });
    iconCache.set(markup, pending);
  }
  return pending;
}

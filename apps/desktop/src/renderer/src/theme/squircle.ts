/** Switches on the superellipse corners the floating cards wear (styles.css's `:root[data-squircle]`
 *  block, drawn by public/squircle-paint.js).
 *
 *  The gate is set only once the worklet module has actually loaded, and that ordering is the whole
 *  point: `background: paint(rl-squircle)` with no registered painter resolves to nothing, so a card
 *  that opted in before the module arrived would render as an invisible box. Everything outside the
 *  gate is the fallback — `border-radius` plus `corner-shape: squircle`, which is a circular corner
 *  today and the real thing once Electron ships Chromium 139. */

/** The CSS Painting API is not in lib.dom. Only the one call this file makes is declared. */
declare const CSS: {
  registerProperty(definition: PropertyDefinition): void;
  paintWorklet?: { addModule(url: string): Promise<void> };
};

/** The painter's inputs. They have to be REGISTERED rather than left as plain custom properties: the
 *  computed value of an unregistered property is its substituted token stream, so the worklet would
 *  receive the text `calc(16px + 4px)` and `color-mix(in srgb, …)` instead of a length and a colour,
 *  and canvas can parse neither. */
const PAINT_INPUTS: readonly PropertyDefinition[] = [
  { name: "--sq-fill", syntax: "<color>", initialValue: "transparent", inherits: false },
  { name: "--sq-ring", syntax: "<color>", initialValue: "transparent", inherits: false },
  { name: "--sq-ring-w", syntax: "<length>", initialValue: "0px", inherits: false },
  { name: "--sq-radius-top", syntax: "<length>", initialValue: "0px", inherits: false },
  { name: "--sq-radius-bottom", syntax: "<length>", initialValue: "0px", inherits: false },
];

export async function enableSquircles(root: HTMLElement = document.documentElement): Promise<boolean> {
  const worklet = CSS.paintWorklet;
  if (!worklet) return false;
  // Registering a name twice throws, and a second call means the properties are already there —
  // which is a success, not a reason to leave the app on the fallback.
  for (const definition of PAINT_INPUTS) {
    try { CSS.registerProperty(definition); } catch { /* already registered */ }
  }
  try {
    // Resolved against the document rather than this module: the painter is a `public/` file, so it
    // sits beside index.html in the build and at the dev server's root. It cannot be an inline blob:
    // or data: URL — the renderer's CSP is `script-src 'self'` and rejects both.
    await worklet.addModule(new URL("squircle-paint.js", document.baseURI).href);
  } catch {
    return false;
  }
  root.setAttribute("data-squircle", "");
  return true;
}

import type { InstalledFont } from "@realm/contracts";

/**
 * Where a font family can come from, and how each one reaches the document.
 *
 * Two sources, and they need opposite things. A family already installed on the Mac needs nothing at
 * all: `queryLocalFonts()` names it and CSS uses it, because the OS already has the file. A family
 * from Google Fonts has been downloaded into `~/Realm/fonts` and has to be given to the document as
 * an `@font-face` before any rule naming it means anything.
 */

/** The families installed on this Mac, deduplicated and sorted.
 *
 *  `queryLocalFonts()` answers with FACES — seven hundred of them on this machine, "Al Bayan Plain"
 *  and "Al Bayan Bold" as separate entries — and a picker wants families. Empty rather than throwing
 *  when the API is missing or refused: this is an extra source of choices, and losing it must not
 *  cost the user the bundled and Google ones beside it. */
export async function localFamilies(): Promise<string[]> {
  const q = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (typeof q !== "function") return [];
  try {
    const faces = await q();
    return [...new Set(faces.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

/** The `<style>` element holding every downloaded family's `@font-face`. One element, replaced
 *  wholesale: the set is small, and a per-family element would be a set of nodes to reconcile. */
const STYLE_ID = "realm-installed-fonts";

/**
 * Publish the downloaded families to the document.
 *
 * `url(data:...)` rather than a file path or a custom protocol. The bytes have already crossed the
 * socket, the rules have to exist before the first paint that names one, and a second way to serve
 * files out of the Realm home would be a second set of path checks to get right for tens of
 * kilobytes of saving.
 *
 * `font-display: block` and not `swap`: this runs at boot, before the window is shown, and a swap
 * would paint the whole app in the fallback and then reflow every label a moment later. The block
 * period is milliseconds because the bytes are already here.
 */
export function publishFontFaces(faces: { family: string; weight: number; base64: string }[]): void {
  const el = document.getElementById(STYLE_ID) ?? document.head.appendChild(
    Object.assign(document.createElement("style"), { id: STYLE_ID }),
  );
  el.textContent = faces.map((f) =>
    `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;font-display:block;` +
    `src:url(data:font/woff2;base64,${f.base64}) format("woff2")}`,
  ).join("\n");
}

/** What `publishFontFaces` needs, gathered for every installed family. Fetched in parallel because
 *  each is an independent read of a file that is already on disk. */
export async function loadInstalledFaces(
  fonts: readonly InstalledFont[],
  read: (family: string) => Promise<{ faces: { weight: number; base64: string }[] }>,
): Promise<{ family: string; weight: number; base64: string }[]> {
  const per = await Promise.all(fonts.map(async (f) => {
    try { return (await read(f.family)).faces.map((x) => ({ family: f.family, ...x })); }
    catch { return []; } // one family that will not read is one family, not the set
  }));
  return per.flat();
}

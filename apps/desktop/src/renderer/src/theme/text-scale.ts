/**
 * The UI and code text sizes, applied to every size the stylesheet states.
 *
 * styles.css writes its sizes in px — five hundred of them, each a judgement about one surface — and
 * a size preference has to move all of them without flattening them into one number. So the build
 * rewrites each one as a multiple of `--text-scale` (`electron.vite.config.ts`, `realm:text-scale`)
 * and the stylesheet stays written at the size it was designed at: with the preferences at their
 * defaults the scale is 1 and every size is exactly what the source says.
 *
 * `--text-scale` is the code scale on any element whose own rule sets the code face, and the UI
 * scale on one whose rule sets the UI or content face; everything else inherits it with the face.
 * That is the same reach the two face preferences already have — "Code font" is every surface set in
 * `--font-mono`, so "Code font size" is too.
 *
 * Two kinds of size stay as written. A size under the 11px floor is one of the named exceptions in
 * styles.test.ts — text inside a box whose height is fixed by something other than the text — and
 * scaling it would overflow the box it was sized for. And every scaled size is floored at 11px, so a
 * smaller preference shrinks the reading text without taking a label under the type floor.
 */

export const UI_TEXT_SCALE = "--ui-text-scale";
export const CODE_TEXT_SCALE = "--code-text-scale";
const FLOOR_PX = 11;

/** A declaration that sets the face, by which face it sets. Read off the rule's own body, because
 *  that is the element the custom property is declared on and inherited from. */
const SETS_CODE_FACE = /(?:^|;|\s)font(?:-family)?\s*:[^;]*var\(--font-mono\)/;
const SETS_UI_FACE = /(?:^|;|\s)font(?:-family)?\s*:[^;]*var\(--font-(?:ui|content)\)/;

const times = (px: string): string => `calc(${px}px * var(--text-scale, 1))`;
const size = (px: string): string => `max(${FLOOR_PX}px, ${times(px)})`;
const underFloor = (px: string): boolean => Number(px) < FLOOR_PX;

function scaleBody(body: string): string {
  // A rule holding one of the fixed-box exceptions keeps its px line-height with its size: the two
  // were sized against the same box.
  const fixedBox = /font-size\s*:\s*(\d+(?:\.\d+)?)px/.exec(body)?.[1];
  const keepsLeading = fixedBox !== undefined && underFloor(fixedBox);
  let out = body
    .replace(/(font-size\s*:\s*)(\d+(?:\.\d+)?)px/g, (m, lead: string, px: string) => (underFloor(px) ? m : lead + size(px)))
    .replace(/((?:^|[;\s])font\s*:\s*[^;]*?)(\d+(?:\.\d+)?)px(?:\/(\d+(?:\.\d+)?)px)?/g,
      (m, lead: string, px: string, leading: string | undefined) =>
        underFloor(px) ? m : lead + size(px) + (leading ? `/${times(leading)}` : ""));
  if (!keepsLeading) out = out.replace(/(line-height\s*:\s*)(\d+(?:\.\d+)?)px/g, (_m, lead: string, px: string) => lead + times(px));
  const scale = SETS_CODE_FACE.test(body) ? CODE_TEXT_SCALE : SETS_UI_FACE.test(body) ? UI_TEXT_SCALE : null;
  return scale ? ` --text-scale: var(${scale}, 1);${out}` : out;
}

/**
 * The stylesheet with every px text size (11px and up) multiplied by `--text-scale`, and each rule
 * that sets a face declaring which scale its element carries.
 *
 * Text only — the shape of the CSS is untouched. Comments are set aside first, because they quote
 * rules (braces, sizes and all) and are not rules; then each innermost block is a declaration list,
 * so a rule inside `@media` or `@container` is rewritten exactly like one outside.
 */
export function scaleTextSizes(css: string): string {
  const comments: string[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (c) => `/*${comments.push(c) - 1}*/`);
  const scaled = bare.replace(/\{([^{}]*)\}/g, (_m, body: string) => `{${scaleBody(body)}}`);
  return scaled.replace(/\/\*(\d+)\*\//g, (_m, i: string) => comments[Number(i)]!);
}

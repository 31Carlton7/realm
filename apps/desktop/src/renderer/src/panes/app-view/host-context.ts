/**
 * What a view is told about the host it is drawn in (MCP Apps `hostContext`): the theme, Realm's
 * palette under the spec's standard variable names, and the room it has.
 *
 * The variables are Realm's own tokens, read off `:root` at the moment they are sent, so a view that
 * uses them (the spec asks views to, with fallbacks) is drawn in whichever theme and face the window
 * is in — and is told again when that changes. A view is free to ignore every one of them: it is the
 * vendor's drawing, and Realm only offers the ground it stands on.
 */

/** Spec variable → the Realm token it is read from. The backgrounds start at `--surface` because that
 *  is the ground Realm lays a view on; a view that paints `--color-background-primary` disappears
 *  into it rather than drawing a slab of another colour. */
const COLOR_TOKENS: Record<string, string> = {
  "--color-background-primary": "--surface",
  "--color-background-secondary": "--inset",
  "--color-background-tertiary": "--hover",
  "--color-background-inverse": "--ink",
  "--color-background-ghost": "--hover",
  "--color-background-info": "--accent-tint",
  "--color-background-danger": "--red-tint",
  "--color-background-success": "--green-tint",
  "--color-background-warning": "--orange-tint",
  "--color-background-disabled": "--inset",
  "--color-text-primary": "--ink",
  "--color-text-secondary": "--ink-2",
  "--color-text-tertiary": "--ink-3",
  "--color-text-inverse": "--canvas",
  "--color-text-info": "--accent-ink",
  "--color-text-danger": "--red",
  "--color-text-success": "--green",
  "--color-text-warning": "--orange",
  "--color-text-disabled": "--ink-3",
  "--color-text-ghost": "--ink-3",
  "--color-border-primary": "--line-strong",
  "--color-border-secondary": "--line",
  "--color-border-tertiary": "--line-soft",
  "--color-border-inverse": "--ink",
  "--color-border-ghost": "--line-soft",
  "--color-border-info": "--accent",
  "--color-border-danger": "--red",
  "--color-border-success": "--green",
  "--color-border-warning": "--orange",
  "--color-border-disabled": "--line",
  "--color-ring-primary": "--accent",
  "--color-ring-secondary": "--line-strong",
  "--color-ring-inverse": "--ink",
  "--color-ring-info": "--accent",
  "--color-ring-danger": "--red",
  "--color-ring-success": "--green",
  "--color-ring-warning": "--orange",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
  "--shadow-hairline": "--shadow-hairline",
  "--shadow-sm": "--shadow-pill",
  "--shadow-md": "--shadow-card",
  "--shadow-lg": "--shadow-overlay",
};

/** The type ladder and radii as values — Realm's rungs (design.md: nine sizes, the radius ladder),
 *  not tokens a view could read the meaning of. */
const FIXED: Record<string, string> = {
  "--font-weight-normal": "400", "--font-weight-medium": "500", "--font-weight-semibold": "560", "--font-weight-bold": "600",
  "--font-text-xs-size": "11px", "--font-text-sm-size": "12px", "--font-text-md-size": "14px", "--font-text-lg-size": "15px",
  "--font-text-xs-line-height": "14px", "--font-text-sm-line-height": "16px", "--font-text-md-line-height": "20px", "--font-text-lg-line-height": "22px",
  "--font-heading-xs-size": "13px", "--font-heading-sm-size": "14px", "--font-heading-md-size": "15px", "--font-heading-lg-size": "18px",
  "--font-heading-xl-size": "20px", "--font-heading-2xl-size": "24px", "--font-heading-3xl-size": "28px",
  "--font-heading-xs-line-height": "16px", "--font-heading-sm-line-height": "20px", "--font-heading-md-line-height": "22px", "--font-heading-lg-line-height": "24px",
  "--font-heading-xl-line-height": "26px", "--font-heading-2xl-line-height": "30px", "--font-heading-3xl-line-height": "34px",
  "--border-radius-xs": "2px", "--border-radius-sm": "6px", "--border-radius-md": "8px", "--border-radius-lg": "12px",
  "--border-radius-xl": "16px", "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
};

export type HostStyles = { variables: Record<string, string> };

/** The standard variables, from the tokens as they stand on `doc` right now. A token the stylesheet
 *  does not hold (a component test) is left out rather than sent empty — the view's own fallback is
 *  the better answer than nothing. */
export function hostStyles(doc: Document = document): HostStyles {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  const variables: Record<string, string> = { ...FIXED };
  for (const [name, token] of Object.entries(COLOR_TOKENS)) {
    const value = style?.getPropertyValue(token).trim();
    if (value) variables[name] = value;
  }
  return { variables };
}

/** The face the window is in. */
export function hostTheme(doc: Document = document): "light" | "dark" {
  return doc.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
}

/** Calls `fn` whenever the window's theme or face changes — the attributes `applyTheme` writes. */
export function onThemeChange(fn: () => void, doc: Document = document): () => void {
  const mo = new MutationObserver(fn);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme", "style", "class"] });
  return () => mo.disconnect();
}

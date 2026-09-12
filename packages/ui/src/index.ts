export { Icon, icons, isIconName, type IconName } from "./Icon";
/* The marks by name, for the one renderer that writes HTML rather than React: assistant markdown,
   which draws a link to a known app as a chip and needs the path data as a string. */
export { brandMarks, type BrandName } from "./brand-icons";
export { applyTheme, clampGroundAlpha, DEFAULT_GROUND_ALPHA, GROUND_ALPHA_RANGE, type Mode } from "./theme";
/* The colour maths, the seed shape and the VS Code translator moved to `@realm/contracts` — the
   server imports all three to translate a theme file, and this package is React. Import them from
   there; nothing is re-exported here, so there is one place each of them comes from. */
/* Only what is consumed OUTSIDE this package. The colour maths and the derivation internals
   (hexToOklch, contrast, luminance, CONTRAST_FLOOR, THEME_VARS, themeVars, resolveMode, the HSL
   helpers, spaceColor, the brand marks, the document and seed types, and the role lists the parsers
   walk) stay exported from their own modules, where applyTheme and the package's own suites import
   them directly — a barrel entry for each would advertise a public API nothing consumes. */
export { exportTheme, importTheme } from "./theme-io";
export { DEFAULT_FONTS, FONT_FACES, FONT_WEIGHTS, parseFontPref,
  type FontId, type FontPref, type FontRole, type FontWeight } from "./fonts";
export { allThemes, clampContrast, CONTRAST_RANGE, contrastMisses, DEFAULT_SELECTION, deriveVars, isHexColour, isOverridden,
  isThemeName, overrideKey, paletteFor, parseThemeOverrides, REALM_SEED, seedFor, setCustomThemes, THEMES, themeModes, themeSwatches,
  type ThemeDef, type ThemeName, type ThemeOverride, type ThemeOverrides, type ThemeSelection } from "./themes";

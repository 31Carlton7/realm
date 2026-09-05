export { Icon, icons, isIconName, type IconName } from "./Icon";
export { brandMarks, isBrandName, type BrandMark, type BrandName } from "./brand-icons";
export { applyTheme, clampGroundAlpha, DEFAULT_GROUND_ALPHA, GROUND_ALPHA_RANGE, hexToHsl, hslToHex, spaceColor,
  type Hsl, type Mode } from "./theme";
/* Only what is consumed OUTSIDE this package. The colour maths and the derivation internals
   (hexToOklch, contrast, luminance, CONTRAST_FLOOR, THEME_VARS, themeVars, themeModes and the seed
   types) stay exported from their own modules, where applyTheme and the package's own suites import
   them directly — a barrel entry for each would advertise a public API nothing consumes. */
export { oklchToHex } from "./oklch";
export { exportTheme, importTheme, THEME_DOC_VERSION, type ThemeDocument, type ThemeImport } from "./theme-io";
export { DEFAULT_FONTS, FONT_FACES, FONT_VARS, FONT_WEIGHTS, FONT_WEIGHT_SHIFT, fontVars, parseFontPref,
  type FontId, type FontPref, type FontRole, type FontWeight } from "./fonts";
export { clampContrast, CONTRAST_RANGE, contrastMisses, DEFAULT_SELECTION, deriveVars, isHexColour, isOverridden, isThemeName, overrideKey,
  paletteFor, parseThemeOverride, parseThemeOverrides, REALM_SEED, resolveMode, seedFor, SEED_ROLES, SYNTAX_ROLES,
  THEMES, themeModes, themeSwatches, type ContrastMiss, type ThemeName, type ThemeOverride, type ThemeOverrides,
  type ThemeSeed, type ThemeSelection } from "./themes";

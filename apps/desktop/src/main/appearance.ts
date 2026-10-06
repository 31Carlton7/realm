import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The window's native appearance follows Realm's theme setting, not only the Mac's.
 *
 * Everything native in the window — the material behind the sidebar and panes, the menus, Quick Look,
 * the Share sheet, dialogs, scrollbars — is drawn in the APP's appearance, which defaults to the
 * system's. Realm's own Light on a Mac set to Dark therefore laid a light ground at 55% over a DARK
 * material, and the sidebar and panes came out a muddy mid-grey: light mode "hard to see", with every
 * label sitting on grey. A Mac app with its own appearance setting sets NSApp's appearance to match,
 * which is `nativeTheme.themeSource` here.
 *
 * The choice is also kept in userData and applied before the first window, so a launch in Light does
 * not open on the dark material for the frame it takes the renderer to say so.
 */
export type AppearancePref = "system" | "light" | "dark";
const PREFS: readonly AppearancePref[] = ["system", "light", "dark"];
export const isAppearancePref = (v: unknown): v is AppearancePref => typeof v === "string" && (PREFS as readonly string[]).includes(v);

export type NativeTheme = { themeSource: AppearancePref };

export function savedAppearance(dir: string, read = (p: string) => readFileSync(p, "utf8")): AppearancePref {
  try {
    const raw = JSON.parse(read(join(dir, "appearance.json"))) as { pref?: unknown };
    return isAppearancePref(raw.pref) ? raw.pref : "system";
  } catch {
    return "system";
  }
}

/** `appearance:set` — the renderer's theme preference, every time it changes (and once at start). */
export function registerAppearance(deps: {
  on: (channel: string, fn: (e: unknown, ...args: unknown[]) => void) => void;
  theme: NativeTheme;
  dir: string;
  write?: (path: string, data: string) => void;
}): void {
  const { on, theme, dir, write = writeFileSync } = deps;
  on("appearance:set", (_e, pref) => {
    if (!isAppearancePref(pref) || theme.themeSource === pref) return;
    theme.themeSource = pref;
    try { write(join(dir, "appearance.json"), JSON.stringify({ pref })); } catch { /* the launch falls back to system */ }
  });
}

import { createRequire } from "node:module";

/** The Hugeicons Pro pack. It is an optional dependency: pnpm installs it where the registry token is
 *  set and skips it everywhere else (docs/dev/hugeicons.md). */
export const HUGEICONS_PRO = "@hugeicons-pro/core-stroke-rounded";

/** Whether this checkout has the Pro pack. pnpm leaves a skipped optional dependency's link pointing at
 *  nothing, which resolves as missing, the same as no link at all. */
export function hasHugeiconsPro(): boolean {
  try {
    createRequire(import.meta.url).resolve(HUGEICONS_PRO);
    return true;
  } catch {
    return false;
  }
}

/** For a Vite config's `resolve.alias`: `#hugeicons` is the Pro pack where it is installed. With no
 *  alias, `#hugeicons` is `hugeicons.ts`, the free pack, through this package's `imports`. */
export function hugeiconsAlias(): Record<string, string> {
  return hasHugeiconsPro() ? { "#hugeicons": HUGEICONS_PRO } : {};
}

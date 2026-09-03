import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** KaTeX ships each of its 20 faces three times — woff2, woff and truetype — and Vite emits every
 *  file the stylesheet names, so importing it unchanged puts 60 font files and ~1.1MB in the bundle
 *  to serve one format. The renderer is Chromium and only Chromium; it has read woff2 since v36.
 *
 *  Rewriting the `src:` list here rather than vendoring a forked copy of katex.min.css keeps the
 *  package the single source of truth: a KaTeX upgrade brings its own positioning CSS with it, and
 *  there is no local copy to drift out of step with the renderer that emits the markup. */
const katexWoff2Only = (): Plugin => ({
  name: "realm:katex-woff2-only",
  enforce: "pre",
  transform(code: string, id: string) {
    if (!id.includes("katex") || !id.endsWith(".css")) return null;
    const out = code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
    return out === code ? null : { code: out, map: null };
  },
});
export default defineConfig({
  // __REALM_SIGNED_BUILD__ feeds the updater gate (src/main/updater.ts): true only when the build
  // env carries signing credentials — the same CSC_* vars electron-builder signs from — so a signed
  // `pnpm dist` flips the gate's `signed` input with zero code changes (Plan 15 W1/W3).
  main: { define: { __REALM_SIGNED_BUILD__: JSON.stringify(Boolean(process.env.CSC_LINK || process.env.CSC_NAME)) } },
  preload: {},
  // host 127.0.0.1 so the dev-server / HMR socket matches the renderer CSP (connect-src 127.0.0.1 only)
  // Tailwind v4 runs in the renderer only (Plan 9 W1): electron-vite composes vite plugins per target.
  renderer: { plugins: [katexWoff2Only(), react(), tailwindcss()], server: { host: "127.0.0.1" } },
});

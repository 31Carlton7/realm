import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { scaleTextSizes } from "./src/renderer/src/theme/text-scale";

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
/** The UI and code text-size preferences reach every size styles.css states by multiplying it at
 *  build time rather than restating five hundred declarations by hand — see `theme/text-scale.ts`.
 *  At the default sizes the multiplier is 1 and the stylesheet renders exactly as written. */
const textScale = (): Plugin => ({
  name: "realm:text-scale",
  enforce: "pre",
  transform(code: string, id: string) {
    if (!/[\\/]src[\\/]renderer[\\/]src[\\/]styles\.css(?:\?.*)?$/.test(id)) return null;
    return { code: scaleTextSizes(code), map: null };
  },
});
/** The files pdf.js reads at run time rather than imports: the Adobe CMaps a CJK PDF needs, the
 *  standard fonts a PDF that embeds none is drawn in, and the WASM decoders for JPX and JBIG2 scans
 *  (with their plain-JS fallbacks) and ICC colour. They are copied beside index.html under `pdfjs/`
 *  and served from there in dev, so the renderer finds them at one relative URL either way
 *  (panes/documents/pdf-source.ts). Without them a CJK PDF draws boxes and a scan draws nothing.
 *  `quickjs-eval` is left out: it runs a PDF's own JavaScript, which Realm never enables. */
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"] as const;
const pdfjsRoot = (): string => dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pdfjsFiles = (): { name: string; file: string }[] => PDFJS_DIRS.flatMap((dir) =>
  readdirSync(join(pdfjsRoot(), dir)).filter((f) => !f.startsWith("quickjs-eval"))
    .map((f) => ({ name: `pdfjs/${dir}/${f}`, file: join(pdfjsRoot(), dir, f) })));
const pdfjsAssets = (): Plugin => ({
  name: "realm:pdfjs-assets",
  configureServer(server) {
    const files = new Map(pdfjsFiles().map((f) => [`/${f.name}`, f.file]));
    server.middlewares.use((req, res, next) => {
      const file = files.get((req.url ?? "").split("?")[0]!);
      if (!file) return next();
      res.setHeader("content-type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      res.end(readFileSync(file));
    });
  },
  generateBundle() {
    for (const f of pdfjsFiles()) this.emitFile({ type: "asset", fileName: f.name, source: readFileSync(f.file) });
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
  renderer: { plugins: [katexWoff2Only(), textScale(), pdfjsAssets(), react(), tailwindcss()], server: { host: "127.0.0.1" } },
});

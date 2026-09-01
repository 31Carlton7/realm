import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  // __REALM_SIGNED_BUILD__ feeds the updater gate (src/main/updater.ts): true only when the build
  // env carries signing credentials — the same CSC_* vars electron-builder signs from — so a signed
  // `pnpm dist` flips the gate's `signed` input with zero code changes (Plan 15 W1/W3).
  main: { define: { __REALM_SIGNED_BUILD__: JSON.stringify(Boolean(process.env.CSC_LINK || process.env.CSC_NAME)) } },
  preload: {},
  // host 127.0.0.1 so the dev-server / HMR socket matches the renderer CSP (connect-src 127.0.0.1 only)
  // Tailwind v4 runs in the renderer only (Plan 9 W1): electron-vite composes vite plugins per target.
  renderer: { plugins: [react(), tailwindcss()], server: { host: "127.0.0.1" } },
});

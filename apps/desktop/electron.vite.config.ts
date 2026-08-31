import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  main: {}, preload: {},
  // host 127.0.0.1 so the dev-server / HMR socket matches the renderer CSP (connect-src 127.0.0.1 only)
  // Tailwind v4 runs in the renderer only (Plan 9 W1): electron-vite composes vite plugins per target.
  renderer: { plugins: [react(), tailwindcss()], server: { host: "127.0.0.1" } },
});

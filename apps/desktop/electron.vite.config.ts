import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  main: {}, preload: {},
  // host 127.0.0.1 so the dev-server / HMR socket matches the renderer CSP (connect-src 127.0.0.1 only)
  renderer: { plugins: [react()], server: { host: "127.0.0.1" } },
});

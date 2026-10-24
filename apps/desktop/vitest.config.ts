import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { hugeiconsAlias } from "../../packages/ui/src/hugeicons-pack";
export default defineConfig({
  plugins: [react()],
  // The glyphs the build draws, Pro or free (electron.vite.config.ts), so a test sees what the app shows.
  resolve: { alias: hugeiconsAlias() },
  test: { name: "desktop", environment: "jsdom", include: ["src/renderer/**/*.test.{ts,tsx}", "src/main/**/*.test.ts", "scripts/**/*.test.ts"], setupFiles: ["src/renderer/src/test-setup.ts"] },
});

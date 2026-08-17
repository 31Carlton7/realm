import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { name: "desktop", environment: "jsdom", include: ["src/renderer/**/*.test.{ts,tsx}"], setupFiles: ["src/renderer/src/test-setup.ts"] },
});

import { defineConfig } from "vitest/config";
// The iPhone app's scripts: the palette generated from the desktop's tokens. Plain node, no DOM.
export default defineConfig({ test: { name: "ios", environment: "node", include: ["scripts/*.test.ts"] } });

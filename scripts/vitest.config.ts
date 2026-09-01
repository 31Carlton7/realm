import { defineConfig } from "vitest/config";
// The repo-level scripts (pnpm release) — plain node, no DOM.
export default defineConfig({ test: { name: "scripts", environment: "node", include: ["*.test.ts"] } });

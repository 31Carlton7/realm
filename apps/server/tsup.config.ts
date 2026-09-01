import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"], format: ["esm"], target: "node22", platform: "node",
  outDir: "dist", clean: true, sourcemap: true, external: ["node-pty", "@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"], noExternal: ["@realm/contracts", "@realm/adapters"],
  // node:sqlite has no unprefixed alias; keep the node: protocol on builtin imports.
  removeNodeProtocol: false,
  // Bundled CJS-style deps (ulid) call require() at load; provide it in the ESM bundle.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

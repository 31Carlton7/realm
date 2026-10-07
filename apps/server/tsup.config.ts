import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"], format: ["esm"], target: "node22", platform: "node",
  outDir: "dist", clean: true, sourcemap: true, external: ["node-pty", "@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"], noExternal: ["@realm/contracts", "@realm/adapters", "@xterm/headless"],
  // node:sqlite has no unprefixed alias; keep the node: protocol on builtin imports.
  removeNodeProtocol: false,
  // `@xterm/headless` is CJS, and tsup leaves anything in `dependencies` external by default — so it
  // shipped as a bare `import { Terminal } from "@xterm/headless"` in an ESM bundle, which Node
  // refuses at load: "Named export 'Terminal' not found". Bundling it makes esbuild resolve that name
  // at BUILD time, where a failure is a build error rather than an app that will not start.
  //
  // Nothing in the suite could have caught this. Vitest resolves the import through its own
  // transform, and `pnpm build` compiles the bundle without ever executing it — the first run is the
  // packaged app's. Verified by booting dist/main.js on a scratch REALM_HOME.
  // Bundled CJS-style deps (ulid) call require() at load; provide it in the ESM bundle.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

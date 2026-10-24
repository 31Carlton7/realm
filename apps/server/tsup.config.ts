import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts", "src/realm.ts"], format: ["esm"], target: "node22", platform: "node",
  outDir: "dist", clean: true, sourcemap: true, external: ["node-pty", "@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"], noExternal: ["@realm/contracts", "@realm/adapters", "@realm/remote", "@realm/view", "@xterm/headless", "uqr"],
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
  // `@realm/remote` (Plan 28) points `main` at its TypeScript sources, like the two workspace packages
  // before it: left external, the bundle would import a `.ts` file at runtime and the daemon would not
  // start. Bundled, its Noise and frames are compiled in with everything else. `@realm/view` (the
  // sidebar's Needs you, which Realm Mobile's `home.get` runs) is the same kind of package.
  // Bundled CJS-style deps (ulid) call require() at load; provide it in the ESM bundle.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

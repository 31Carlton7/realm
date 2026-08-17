import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"], format: ["esm"], target: "node22", platform: "node",
  outDir: "dist", clean: true, sourcemap: true, external: ["node-pty"], noExternal: ["@realm/contracts"],
});

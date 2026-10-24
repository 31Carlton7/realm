import { defineConfig } from "vitest/config";
import { hugeiconsAlias } from "./src/hugeicons-pack";
// `#hugeicons` as the desktop build resolves it: the Pro pack where it is installed (src/hugeicons.ts).
export default defineConfig({ resolve: { alias: hugeiconsAlias() }, test: { name: "ui", environment: "node" } });

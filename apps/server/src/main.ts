// Electron main launches this bundle under its own binary with ELECTRON_RUN_AS_NODE=1 (see
// apps/desktop/src/main/server-process.ts). Drop the variable immediately: everything spawned from
// here (terminal shells, agent CLI probes, the agent SDKs' subprocesses) inherits this env, and a
// stray ELECTRON_RUN_AS_NODE=1 breaks any Electron-based tool a child might launch.
delete process.env.ELECTRON_RUN_AS_NODE;

import { createApp } from "./app";
import { realmHome } from "./paths";

const envPort = Number(process.env.REALM_PORT);
const port = Number.isFinite(envPort) && envPort >= 0 ? envPort : 0;
try {
  const home = realmHome();
  const app = await createApp({ home, port });
  // Announce readiness on stdout as a single JSON line; Electron main parses this.
  process.stdout.write(JSON.stringify({ type: "ready", port: app.port, home }) + "\n");
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
  process.exit(1);
}

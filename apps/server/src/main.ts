import { createApp } from "./app";
import { realmHome } from "./paths";

const home = realmHome();
const port = Number(process.env.REALM_PORT ?? 0);
const app = await createApp({ home, port });
// Announce readiness on stdout as a single JSON line; Electron main parses this.
process.stdout.write(JSON.stringify({ type: "ready", port: app.port, home }) + "\n");
const shutdown = async () => { await app.close(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);

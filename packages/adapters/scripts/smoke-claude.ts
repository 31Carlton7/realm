// Manual smoke test against the real Claude Agent SDK. Requires a logged-in `claude` CLI.
// Run: pnpm --filter @realm/adapters exec tsx scripts/smoke-claude.ts
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/claude/claude-adapter";

const adapter = new ClaudeAdapter();
console.log("probe:", await adapter.probe());

const h = adapter.start({ cwd: tmpdir(), mcpServers: [], model: process.env.REALM_SMOKE_MODEL ?? null, onLog: (l) => console.error("[stderr]", l) });
const timer = setTimeout(() => { console.error("timeout"); void h.dispose().then(() => process.exit(2)); }, 90_000);

await h.send({ text: "Reply with exactly: REALM_OK", attachments: [] });
let sawOk = false;
for await (const e of h.events) {
  const summary = e.type === "assistant_delta" ? JSON.stringify(e.payload.delta) : JSON.stringify(e.payload).slice(0, 200);
  console.log(`[${e.type}] ${summary}`);
  if (e.type === "permission_request") h.respondPermission(e.payload.requestId, "deny");
  if (e.type === "assistant_text" && e.payload.text.includes("REALM_OK")) sawOk = true;
  if (e.type === "status" && e.payload.status === "idle" && sawOk) break;
  if (e.type === "status" && e.payload.status === "ended") break;
}
clearTimeout(timer);
await h.dispose();
console.log(sawOk ? "SMOKE OK" : "SMOKE FAILED: no REALM_OK");
process.exit(sawOk ? 0 : 1);

/**
 * Live check of Realm's MCP wiring against the REAL agent CLIs.
 *
 * W2 rests on a claim no unit test can hold up: that a server configured in Realm is a server the agent
 * actually spawns. A unit test can only prove Realm emitted the JSON it meant to emit — and the three
 * protocols disagree about that JSON in ways that fail silently (ACP rejects an `env` record before its
 * own normalizer runs; Codex accepts `thread/start` `config` keys it does not recognise without a word).
 *
 * So this drives the whole stack — `createApp`, the real `McpService`, the real `SessionService`, the
 * real adapters, the real CLIs — with a fixture MCP server that writes a marker file the moment it is
 * started, and asserts:
 *
 *   1. the ENABLED server's marker appears (it reached the agent, and the agent ran it);
 *   2. it carries `token: "match"` (the `env` map survived that protocol's own shape — the ACP quirk);
 *   3. the DISABLED server's marker does NOT (per-space opt-in is real, not decorative);
 *   4. a server enabled in ANOTHER space does not appear either (spaces do not leak into each other).
 *
 * It writes nothing outside its own scratch home and one fixed workspace directory, and in particular
 * nothing under ~/.claude, ~/.codex, ~/.cursor or ~/.agents. No secret is ever printed: the fixture
 * reports a verdict on the token, never the token.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-mcp-check.ts [kinds]
 *   pnpm --filter @realm/server exec tsx scripts/live-mcp-check.ts claude,codex,acp:cursor
 *
 * Exits non-zero if any check fails. Requires the relevant CLIs to be installed and logged in; a CLI
 * that is missing is reported as a skipped section, not a pass.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_HAS_MCP, type AgentKind, type SessionEvent } from "@realm/contracts";
import { createApp, defaultAdapters } from "../src/app";
import { ProfilesStore } from "../src/store/profiles";
import { SpacesStore } from "../src/store/spaces";
import { McpService } from "../src/mcp/service";
import { McpServersStore } from "../src/store/mcp";
import { SettingsStore } from "../src/store/settings";
import { liveWorkspace } from "./live-workspace";
import { finish, ok, sleep } from "./harness";

const KINDS = (process.argv[2] ?? "claude,codex,acp:cursor").split(",").filter(Boolean) as AgentKind[];
/** Generous: `cursor-agent acp` takes tens of seconds to do anything at all. The marker lands at session
 *  start, well before the turn, so this is a ceiling and not a typical wait. */
const MARKER_TIMEOUT_MS = 120_000;
/** Not a credential — a random string this process invents, to prove the env map arrived intact. */
const TOKEN = `realm-probe-${Math.random().toString(36).slice(2)}`;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "marker-mcp-server.mjs");

const skip = (label: string, detail: string) => console.log(`  SKIP  ${label} — ${detail}`);
type Marker = { startedAt: number; args: string[]; token: "match" | "mismatch" | "absent" };
const readMarker = (path: string): Marker | null => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as Marker; } catch { return null; }
};

async function waitForMarker(path: string, timeoutMs: number): Promise<Marker | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = readMarker(path);
    if (m) return m;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "realm-mcp-live-"));
  const markers = mkdtempSync(join(tmpdir(), "realm-mcp-markers-"));
  // A fixed workspace, not a mkdtemp: codex records every cwd it starts a thread in as a trusted project
  // in the user's ~/.codex/config.toml, with no way to opt out (see live-workspace.ts).
  const cwd = liveWorkspace();

  const app = await createApp({ home, port: 0, adapters: defaultAdapters() });
  console.log(`server up on :${app.port}\nmarkers: ${markers}\n`);

  const profile = new ProfilesStore(app.db).create({ name: "MCP live", icon: "home", color: "#7c6cff" });
  const mine = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Mine", icon: "home" });
  const other = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Other", icon: "home" });

  // The same McpService the running app uses: same table, same settings store, same code path that
  // SessionService reads through. Configuring the servers by hand here would prove nothing about it.
  const mcp = new McpService({ servers: new McpServersStore(app.db), settings: new SettingsStore(app.db) });
  const marker = (name: string) => join(markers, `${name}.json`);
  const define = (name: string, spaceId: string | null) => mcp.add({
    name, transport: "stdio", command: process.execPath, args: [FIXTURE, marker(name), TOKEN],
    env: { REALM_MCP_PROBE_TOKEN: TOKEN },
  }, spaceId);

  const probes = await app.sessions.probeAll();

  for (const kind of KINDS) {
    console.log(`\n=== ${kind} ===`);
    const probe = probes.find((p) => p.kind === kind);
    if (!probe?.available) { ok("agent available", false, probe?.reason ?? "not registered"); continue; }
    if (!AGENT_HAS_MCP[kind]) { skip("takes MCP servers at all", `AGENT_HAS_MCP says ${kind} takes none`); continue; }

    // Fresh server names per agent: a marker left by the previous agent's session would pass this
    // agent's check for free.
    const tag = kind.replace(/[^a-z0-9]/gi, "_");
    const on = define(`on_${tag}`, mine.id);
    const off = define(`off_${tag}`, null);
    const elsewhere = define(`elsewhere_${tag}`, other.id);

    const { session } = app.sessions.create({
      spaceId: mine.id, agentKind: kind, projectId: null,
      model: null, effort: null, permissionMode: "default",
    });
    app.db.prepare("UPDATE environments SET path = ? WHERE id = ?").run(cwd, session.environmentId);

    // The prompt exists only to make SessionService boot the adapter; the marker lands at session start
    // and nothing here waits for an answer. Claude does not connect an MCP server until something needs
    // it, so the prompt names the tool — the point is still spawn-time, not the model's reply.
    await app.sessions.send(session.id, { text: "List your available tools. Do not call any of them.", attachments: [] });
    const hit = await waitForMarker(marker(on.name), MARKER_TIMEOUT_MS);

    const errs = app.sessions.events(session.id, 0, 1000)
      .map((s) => s.event as SessionEvent)
      .filter((e) => e.type === "error")
      .map((e) => (e.payload as { message: string }).message);

    ok("the enabled server was started by the agent", hit !== null, hit ? `after ${Date.now() - hit.startedAt}ms` : "no marker");
    ok("its env survived this protocol's own shape", hit?.token === "match", hit?.token ?? "(no marker)");
    ok("its args survived", JSON.stringify(hit?.args ?? []) === "[]", JSON.stringify(hit?.args ?? "(no marker)"));
    ok("a server enabled in no space was NOT started", readMarker(marker(off.name)) === null);
    ok("a server enabled in ANOTHER space was NOT started", readMarker(marker(elsewhere.name)) === null);
    ok("the session reported no errors", errs.length === 0, errs.join(" | ").slice(0, 240));

    await app.sessions.closeAll();
    (app.sessions as unknown as { closing: boolean }).closing = false;
  }

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(markers, { recursive: true, force: true });
  // `cwd` is left on disk on purpose — see live-workspace.ts.
  finish();
}

main().catch((e) => { console.error("driver crashed:", e); process.exit(2); });

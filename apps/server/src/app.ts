import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { SettingsStore } from "./store/settings";
import { TerminalsStore } from "./store/terminals";
import { TerminalService } from "./terminals/service";
import { SessionsStore, SessionEventsStore } from "./store/sessions";
import { SessionService } from "./sessions/service";
import { ClaudeAdapter, CodexAdapter, AcpAdapter, FakeAdapter, type AdapterRegistry } from "@realm/adapters";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";

export type App = { port: number; db: Db; terminals: TerminalService; sessions: SessionService; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

/**
 * Claude, Codex and both ACP agents are always registered; availability is reported by `agents.probe` so the
 * New Session sheet can disable the ones that are not installed or not signed in. The scripted fake is only
 * registered when REALM_ENABLE_FAKE_AGENT=1 (offline dev).
 */
export function defaultAdapters(): AdapterRegistry {
  const reg: AdapterRegistry = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    "acp:cursor": new AcpAdapter({
      kind: "acp:cursor",
      bin: process.env.REALM_CURSOR_BIN ?? "cursor-agent",
      args: ["acp"],
      label: "Cursor",
      loginHint: "Run `cursor-agent login`.",
    }),
    "acp:gemini": new AcpAdapter({
      kind: "acp:gemini",
      bin: process.env.REALM_GEMINI_BIN ?? "gemini",
      args: ["--acp"],
      label: "Gemini",
      loginHint: "Gemini's free personal tier was discontinued — configure a Gemini API key or Vertex AI credentials.",
    }),
  };
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1") reg.fake = new FakeAdapter({ script: [], delayMs: 15 });
  return reg;
}

export async function createApp(opts: { home: string; port: number; adapters?: AdapterRegistry }): Promise<App> {
  const db = openDatabase(dbPath(opts.home));
  const rpc = new RpcServer();
  const spaces = new SpacesStore(db, opts.home);
  const items = new ItemsStore(db);
  const projects = new ProjectsStore(db);
  const terminals = new TerminalService({ db, rpc, spaces, items, terminals: new TerminalsStore(db) });
  const sessions = new SessionService({ db, rpc, sessions: new SessionsStore(db), events: new SessionEventsStore(db), items, spaces, projects, adapters: opts.adapters ?? defaultAdapters() });
  registerMethods({
    rpc, home: opts.home, version: SERVER_VERSION,
    profiles: new ProfilesStore(db), spaces, projects, items, settings: new SettingsStore(db), terminals, sessions,
  });
  sessions.markStaleOnBoot();
  terminals.restoreAll();
  const port = await rpc.listen(opts.port);
  return { port, db, terminals, sessions, close: async () => { terminals.closeAll(); await sessions.closeAll(); await rpc.close(); db.close(); } };
}

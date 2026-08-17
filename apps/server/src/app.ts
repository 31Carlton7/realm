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
import { ClaudeAdapter, FakeAdapter, type AdapterRegistry } from "@realm/adapters";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";

export type App = { port: number; db: Db; terminals: TerminalService; sessions: SessionService; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

/** Claude always; the scripted fake only when REALM_ENABLE_FAKE_AGENT=1 (offline dev). */
export function defaultAdapters(): AdapterRegistry {
  const reg: AdapterRegistry = { claude: new ClaudeAdapter() };
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

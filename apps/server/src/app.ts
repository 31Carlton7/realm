import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { TerminalsStore } from "./store/terminals";
import { TerminalService } from "./terminals/service";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";

export type App = { port: number; db: Db; terminals: TerminalService; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

export async function createApp(opts: { home: string; port: number }): Promise<App> {
  const db = openDatabase(dbPath(opts.home));
  const rpc = new RpcServer();
  const spaces = new SpacesStore(db, opts.home);
  const items = new ItemsStore(db);
  const terminals = new TerminalService({ db, rpc, spaces, items, terminals: new TerminalsStore(db) });
  registerMethods({
    rpc, home: opts.home, version: SERVER_VERSION,
    profiles: new ProfilesStore(db), spaces, projects: new ProjectsStore(db), items, terminals,
  });
  terminals.restoreAll();
  const port = await rpc.listen(opts.port);
  return { port, db, terminals, close: async () => { terminals.closeAll(); await rpc.close(); db.close(); } };
}

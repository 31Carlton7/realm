import { openDatabase, type Db } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";
import { SpacesStore } from "./store/spaces";
import { ProjectsStore } from "./store/projects";
import { ItemsStore } from "./store/items";
import { TerminalManager } from "./terminals/manager";
import { RpcServer } from "./rpc/server";
import { registerMethods } from "./rpc/methods";

export type App = { port: number; db: Db; close(): Promise<void> };
export const SERVER_VERSION = "0.0.1";

export async function createApp(opts: { home: string; port: number }): Promise<App> {
  const db = openDatabase(dbPath(opts.home));
  const rpc = new RpcServer();
  const terminals = new TerminalManager({
    onData: (terminalId, data) => rpc.broadcast("terminal.data", { terminalId, data }),
    onExit: (terminalId, exitCode) => rpc.broadcast("terminal.exit", { terminalId, exitCode }),
  });
  registerMethods({
    rpc, db, home: opts.home, version: SERVER_VERSION,
    profiles: new ProfilesStore(db), spaces: new SpacesStore(db, opts.home),
    projects: new ProjectsStore(db), items: new ItemsStore(db), terminals,
  });
  const port = await rpc.listen(opts.port);
  return { port, db, close: async () => { terminals.closeAll(); await rpc.close(); db.close(); } };
}

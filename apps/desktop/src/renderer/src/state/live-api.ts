import { rpc } from "../rpc/client";
import { getTerminalHub } from "../panes/terminal-hub";
import type { Api } from "./store";

/** The real Api: realm-server over WebSocket plus the Electron/xterm platform seams.
 *  Kept out of store.ts so the store (and its tests) never pull in xterm or the rpc singleton. */
export const liveApi = (): Api => ({
  listProfiles: () => rpc().call("profiles.list", {}),
  listSpaces: () => rpc().call("spaces.list", {}),
  listItems: (spaceId) => rpc().call("items.list", { spaceId }),
  listProjects: (spaceId) => rpc().call("projects.list", { spaceId }),
  createSpace: (input) => rpc().call("spaces.create", input),
  updateSpace: (input) => rpc().call("spaces.update", input),
  reorderSpaces: async (ids) => { await rpc().call("spaces.reorder", { ids }); },
  deleteSpace: async (id) => { await rpc().call("spaces.delete", { id }); },
  createProject: (spaceId, name, rootPath) => rpc().call("projects.create", { spaceId, name, rootPath }),
  setLayout: (id, layout) => rpc().call("spaces.setLayout", { id, layout }),
  createTerminal: (spaceId) => rpc().call("terminals.create", { spaceId }),
  updateItem: (input) => rpc().call("items.update", input),
  deleteItem: async (id) => { await rpc().call("items.delete", { id }); },
  getSetting: async (key) => (await rpc().call("settings.get", { key })).value,
  setSetting: async (key, value) => { await rpc().call("settings.set", { key, value }); },
  pickFolder: () => window.realm.pickFolder(),
  disposeTerminal: (terminalId) => getTerminalHub().dispose(terminalId),
});

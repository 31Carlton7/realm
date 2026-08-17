import { rpc } from "../rpc/client";
import { getTerminalHub } from "../panes/terminal-hub";
import type { Api } from "./store";

/** The real Api: realm-server over WebSocket plus the Electron/xterm platform seams.
 *  Kept out of store.ts so the store (and its tests) never pull in xterm or the rpc singleton. */
export const liveApi = (): Api => ({
  listProfiles: () => rpc().call("profiles.list", {}),
  listSpaces: (profileId) => rpc().call("spaces.list", { profileId }),
  listItems: (spaceId) => rpc().call("items.list", { spaceId }),
  listProjects: (spaceId) => rpc().call("projects.list", { spaceId }),
  createProfile: (name) => rpc().call("profiles.create", { name }),
  createSpace: (profileId, name) => rpc().call("spaces.create", { profileId, name }),
  createProject: (spaceId, name, rootPath) => rpc().call("projects.create", { spaceId, name, rootPath }),
  setLayout: (id, layout) => rpc().call("spaces.setLayout", { id, layout }),
  createTerminal: (spaceId) => rpc().call("terminals.create", { spaceId }),
  deleteItem: async (id) => { await rpc().call("items.delete", { id }); },
  pickFolder: () => window.realm.pickFolder(),
  disposeTerminal: (terminalId) => getTerminalHub().dispose(terminalId),
});

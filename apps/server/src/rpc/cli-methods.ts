/**
 * What the token in `daemon.json` may call: the `realm` CLI's own methods, and nothing else.
 *
 * Any agent running with the sandbox off can read that file, so this list is what such an agent can
 * do over the socket. It is an allowlist so a method added later is refused until someone decides
 * the CLI needs it. Never add the ones that answer for the user or loosen what agents may do:
 * `sessions.respondPermission`, `sandbox.set`, `sandbox.setDefaults`, `settings.set`,
 * `terminals.write`, `sessions.setOptions`, `teammates.update`, or the one that sets a team's access.
 *
 * `remote.pair.answer` depends on who owns the server (`ServerOwner`). Realm's window can accept a
 * phone, and a phone an agent paired could answer permission cards as itself, so there the CLI's
 * token is refused it. A server `realm serve` started has no window, and the terminal is the only
 * one there to say yes: refusing it would close no hole and leave no way to pair at all.
 */
export const CLI_METHODS: ReadonlySet<string> = new Set([
  "system.info",
  "projects.open",
  "environments.list",
  "environments.get",
  "environments.createWorktree",
  "environments.worktreeStatus",
  "environments.removeWorktree",
  "terminals.create",
  "terminals.list",
  "terminals.read",
  "terminals.close",
  "workspace.stage",
  "workspace.ship",
  "remote.status",
  "remote.pair.start",
  "remote.pair.cancel",
  "remote.phones.remove",
]);

/** Who started the server. `app` is Realm's own window, which handed its token over the spawn pipe;
 *  `terminal` is `realm serve`, which nobody handed one, so the CLI is the only principal there is. */
export type ServerOwner = "app" | "terminal";

export const cliMayCall = (method: string, owner: ServerOwner): boolean =>
  CLI_METHODS.has(method) || (method === "remote.pair.answer" && owner === "terminal");

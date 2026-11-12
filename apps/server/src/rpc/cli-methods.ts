/**
 * What the token in `daemon.json` may call: the `realm` CLI's own methods, and nothing else.
 *
 * Any agent running with the sandbox off can read that file, so this list is what such an agent can
 * do over the socket. It is an allowlist so a method added later is refused until someone decides
 * the CLI needs it. Never add the ones that answer for the user or loosen what agents may do:
 * `sessions.respondPermission`, `sandbox.set`, `sandbox.setDefaults`, `settings.set`,
 * `terminals.write`, `sessions.setOptions`, `teammates.update`, or the one that sets a team's access. Nor
 * `remote.pair.answer`: a phone the agent paired could answer permission cards as that phone, so
 * `realm pair` opens the window and only Realm's own accepts the phone.
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

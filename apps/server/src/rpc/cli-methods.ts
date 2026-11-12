/**
 * What the token in `daemon.json` may call: the `realm` CLI's own methods, and nothing else.
 *
 * Any agent running with the sandbox off can read that file, so this list is what such an agent can
 * do over the socket. It is an allowlist so a method added later is refused until someone decides
 * the CLI needs it. Never add the ones that answer for the user or loosen what agents may do:
 * `sessions.respondPermission`, `sandbox.set`, `sandbox.setDefaults`, `settings.set`,
 * `terminals.write`.
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
  "remote.pair.answer",
  "remote.phones.remove",
]);

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Every agent process gets `REALM_AGENT_SHELL=1`: an unpackaged Realm started under it, `pnpm dev`
 * included, runs quiet on a user-data folder of its own (apps/desktop/src/main/quiet-windows.ts).
 *
 * The PATH wrappers cover an Electron started by name outside a package script. Inside one,
 * node_modules/.bin comes first and only the variable applies.
 */
const ELECTRON_SHIM = `#!/bin/sh
# Realm's: an Electron an agent starts runs quiet, on a user-data folder of its own.
here=\${0%/*}
PATH=$(printf '%s\\n' "$PATH" | tr ':' '\\n' | grep -vxF "$here" | paste -sd: -)
export REALM_QUIET_WINDOWS=1
case " $* " in
  *" --user-data-dir="*) ;;
  *) set -- "--user-data-dir=\${TMPDIR:-/tmp}/realm-agent-shell/$(pwd | shasum | cut -c1-12)" "$@" ;;
esac
exec electron "$@"
`;

const ELECTRON_VITE_SHIM = `#!/bin/sh
# Realm's: the Electron an agent's electron-vite starts runs quiet.
here=\${0%/*}
PATH=$(printf '%s\\n' "$PATH" | tr ':' '\\n' | grep -vxF "$here" | paste -sd: -)
export REALM_QUIET_WINDOWS=1
exec electron-vite "$@"
`;

/** Writes the wrappers to `<home>/agent-shell/bin` and returns that folder. */
export function installAgentShims(home: string): string {
  const dir = join(home, "agent-shell", "bin");
  mkdirSync(dir, { recursive: true });
  for (const [name, script] of [["electron", ELECTRON_SHIM], ["electron-vite", ELECTRON_VITE_SHIM]] as const) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

export function agentShellEnv(shimDir: string, path: string | undefined): Record<string, string> {
  return { REALM_AGENT_SHELL: "1", PATH: path ? `${shimDir}${delimiter}${path}` : shimDir };
}

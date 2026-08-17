import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function realmHome(): string {
  const h = process.env.REALM_HOME ?? join(homedir(), "Realm");
  mkdirSync(h, { recursive: true });
  return h;
}
export const dbPath = (home = realmHome()) => join(home, "realm.db");

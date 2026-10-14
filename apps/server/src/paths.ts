import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function realmHome(): string {
  const h = process.env.REALM_HOME ?? join(homedir(), "Realm");
  mkdirSync(h, { recursive: true });
  return h;
}
export const dbPath = (home = realmHome()) => join(home, "realm.db");

/** Where an app keeps its own data on this OS: the folder a Mac calls Application Support, Windows'
 *  roaming AppData, and XDG's data home on Linux. */
export function appDataDir(userHome: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return join(userHome, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || join(userHome, "AppData", "Roaming");
  return env.XDG_DATA_HOME || join(userHome, ".local", "share");
}

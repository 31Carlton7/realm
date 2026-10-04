import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the `phonescreen` helper lives (native/PhoneScreen.swift) — dev tree first, then the packaged
 * Resources directory, as for every other native helper. The server runs it to show a real iPhone's
 * screen as live video over the cable; `null` means this build has none, which is a supported state:
 * the picture is then the runner's screenshots, about one a second.
 */
export function phoneScreenPath(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.REALM_PHONESCREEN_BIN) return process.env.REALM_PHONESCREEN_BIN;
  const dev = join(app.getAppPath(), "native", "bin", "phonescreen");
  if (existsSync(dev)) return dev;
  const packaged = join(process.resourcesPath, "phonescreen");
  return existsSync(packaged) ? packaged : null;
}

/** The server's environment entry for it — nothing at all when there is no helper. */
export function phoneScreenEnv(): { REALM_PHONESCREEN_BIN?: string } {
  const bin = phoneScreenPath();
  return bin ? { REALM_PHONESCREEN_BIN: bin } : {};
}

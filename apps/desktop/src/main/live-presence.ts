import { appendFileSync } from "node:fs";

/**
 * The live checks' stand-in for a finger on Touch ID. A script that boots the built app cannot press
 * the sensor, and `systemPreferences.promptTouchID` would put a real prompt on the owner's screen that
 * nothing answers. With this, each ask is a line in `REALM_LIVE_PRESENCE_LOG` and is answered yes —
 * the same deal the scratch `deviceowner` helper gives the login-password check.
 *
 * Honoured ONLY in an unpackaged app booted as a harness (`REALM_ENABLE_FAKE_AGENT=1`, the flag every
 * live check boots with). A packaged Realm ignores it whatever its environment says: a variable that
 * could answer "yes" for the user must never reach a build someone uses.
 */
export function livePresenceStandIn(d: {
  packaged: boolean;
  env: Record<string, string | undefined>;
  append?: (file: string, line: string) => void;
}): ((reason: string) => Promise<boolean>) | null {
  if (d.packaged) return null;
  const log = d.env.REALM_LIVE_PRESENCE_LOG;
  if (d.env.REALM_ENABLE_FAKE_AGENT !== "1" || !log) return null;
  const append = d.append ?? ((file, line) => appendFileSync(file, line));
  return async (reason) => {
    append(log, reason.replace(/\n/g, " ") + "\n");
    return true;
  };
}

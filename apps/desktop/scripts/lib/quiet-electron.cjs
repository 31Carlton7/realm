/**
 * Quiet mode for a live check that IS its own Electron main (`electron scripts/x-live.cjs`) rather
 * than a boot of Realm's: the same patches Realm's main installs under REALM_QUIET_WINDOWS
 * (src/main/quiet-windows.ts), loaded from the build. Require it first, before `app` is ready, and
 * construct windows with `...QUIET_WINDOW_OPTIONS` last, then `show()` them — a window constructed
 * visible is on screen before anything can hide it.
 */
const path = require("node:path");

const { installQuietWindows, QUIET_WINDOW_OPTIONS } = require(path.join(__dirname, "../../out/main/quiet-windows.js"));
installQuietWindows();

module.exports = { QUIET_WINDOW_OPTIONS };

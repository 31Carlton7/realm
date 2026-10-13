/** Baked in by electron.vite.config.ts's `define` at build time: true exactly when the build ran
 *  with signing credentials in the env (CSC_LINK / CSC_NAME — the same vars that make
 *  electron-builder sign; see docs/dev/signing.md). Feeds the updater gate's `signed` input, so a
 *  signed `pnpm dist` lifts the "unsigned" updater reason with zero code changes. */
declare const __REALM_SIGNED_BUILD__: boolean;
/** Baked in by electron.vite.config.ts: this build's version and its section of CHANGELOG.md, read
 *  when the app was built (main/whats-new.ts). */
declare const __REALM_WHATS_NEW__: import("./whats-new").WhatsNewBuild;

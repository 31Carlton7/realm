# Signing & notarization

Plan 15 W3. The wiring is fully in place and **entirely env-driven**: a `pnpm dist` with the six
variables below signs, notarizes and staples with **zero code changes**. Without them it builds the
same unsigned app as always and says so loudly (`[pack] signing DISABLED…`, `[notarize] SKIPPED…`).
Nothing in this repo fakes a signature — an ad-hoc or self-signed workaround would still fail
Gatekeeper on other Macs while hiding the real state, so the build is honestly unsigned until real
credentials exist.

## What each piece does

| Piece | Role |
| --- | --- |
| `apps/desktop/scripts/pack.mjs` | Runs electron-builder. No `CSC_LINK`/`CSC_NAME` in env → appends `-c.mac.identity=null` (skip codesign); otherwise electron-builder signs with the provided identity. |
| `apps/desktop/electron-builder.yml` | `hardenedRuntime: true` + entitlements (`apps/desktop/resources/entitlements.mac.plist`) — used only when signing actually happens. |
| `apps/desktop/scripts/notarize.cjs` | electron-builder `afterSign` hook. Notarizes + staples via `@electron/notarize` when `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` are set **and** the build was signed; otherwise prints exactly why it skipped and does nothing. |
| `electron.vite.config.ts` | Bakes `__REALM_SIGNED_BUILD__` from the same `CSC_*` vars — a signed build's in-app updater gate stops claiming "unsigned" automatically (see `src/main/updater.ts`). |

## The env vars

| Var | What it is |
| --- | --- |
| `CSC_LINK` | The Developer ID Application certificate + key, as a base64 `.p12` (or a `file://` path to it). |
| `CSC_KEY_PASSWORD` | The password that `.p12` was exported with. |
| `APPLE_ID` | The Apple ID of the developer account. |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID (never the account password). |
| `APPLE_TEAM_ID` | The 10-character team id. |
| `CSC_NAME` (alternative) | Instead of `CSC_LINK`: the name of a signing identity already in the login keychain, e.g. `Developer ID Application: Carlton Aikins (XXXXXXXXXX)`. |

## Human steps (one-time)

1. **Enroll** in the Apple Developer Program (developer.apple.com, $99/yr) with your Apple ID.
2. **Create the certificate**: Xcode → Settings → Accounts → your team → Manage Certificates →
   `+` → *Developer ID Application*. (Or: developer.apple.com → Certificates → `+` →
   Developer ID Application, with a CSR from Keychain Access.)
3. **Export it**: Keychain Access → My Certificates → right-click the
   `Developer ID Application: …` cert → Export as `.p12`, choose a strong password.
4. **Base64 it**: `base64 -i realm-signing.p12 | pbcopy` → that clipboard is `CSC_LINK`; the export
   password is `CSC_KEY_PASSWORD`. (Skippable: leave the cert in the keychain and set `CSC_NAME`
   instead — then `CSC_LINK`/`CSC_KEY_PASSWORD` aren't needed.)
5. **App-specific password**: account.apple.com → Sign-In and Security → App-Specific Passwords →
   generate one (label it "realm notarization") → `APPLE_APP_SPECIFIC_PASSWORD`.
6. **Team id**: developer.apple.com → Membership details → `APPLE_TEAM_ID`.
7. Put them somewhere `pnpm dist` can see, **never in the repo** — e.g. `~/.config/realm-signing.env`
   (`chmod 600`) with `export CSC_LINK=… CSC_KEY_PASSWORD=… APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=…`.

## Per release

```sh
source ~/.config/realm-signing.env
pnpm dist            # or pnpm release — same packing path
```

Expect `[pack] signing ENABLED …`, several minutes of `[notarize] submitting …`, then
`[notarize] accepted and stapled`.

## Verify the artifact

```sh
codesign -dv --verbose=2 apps/desktop/release/mac-arm64/Realm.app   # Authority=Developer ID Application: …
spctl -a -t exec -vv apps/desktop/release/mac-arm64/Realm.app       # accepted, source=Notarized Developer ID
xcrun stapler validate apps/desktop/release/mac-arm64/Realm.app     # The validate action worked!
```

Then update README's "Unsigned" note, and revisit the entitlements
(`resources/entitlements.mac.plist` deliberately starts wide: JIT, unsigned executable memory,
library validation off for node-pty's prebuilds) — tighten what a real signed run proves
unnecessary. A signed + notarized release is also one of the two activation conditions for the
in-app updater — see `src/main/updater.ts` and README → Updates.

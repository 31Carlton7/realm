# Codex setup connection

This includes read-only discovery, profile bindings, space overrides, and launch-time inheritance. Codex remains
authoritative. Apply rechecks the preview fingerprint, writes only Realm settings, and produces a
receipt. Rollback restores the prior binding only while the current value still matches that receipt;
later user edits produce a conflict. Launch precedence is session, space, profile, then Codex. Existing
threads retain their recorded immutable settings; incompatible drift is recorded as “New session required.”
Refresh re-scans stored sources, reports fingerprint drift, preserves explicit overrides, and never
restarts running sessions. Disconnect removes the current Realm-owned binding and space overrides
only when its receipt still owns the current state. Rendered UI validation remains pending.

The settings candidate adds a dedicated **Codex setup** tab beside Import. Reference lock: preserve
the existing Settings rail, form fields, source rows, button hierarchy, and system theme behavior;
reuse Import's preview language and status patterns. Reject a parallel settings shell, credential
fields, hidden unavailable states, or treating a definition count as a successful connection. Required
captures are empty, error, preview, connected, stale-preview, and rollback-conflict states in light and
dark mode at the desktop's narrow and standard widths.

Discovery must use the operating-system home and `CODEX_HOME` independently of Realm's data home.
Native configuration, skills, and hook metadata are read through app-server inspection methods.
Supplemental skill roots are explicit; cached plugin versions are never guessed. Only allowlisted
metadata is returned. A successful configuration read is not an authentication or connectivity check.

Run `pnpm --filter @realm/server... install --frozen-lockfile --ignore-scripts`, then
`node scripts/validate-codex-setup.mjs`. This public-dependency test lane does not require the desktop's
private icon package. Every validator invocation writes candidate identity, result, and logs under
`.validation/`. The manifest covers discovery, binding transactions, inheritance, and resume handling;
passing it does not establish refresh, full desktop parity, or rendered UI readiness.

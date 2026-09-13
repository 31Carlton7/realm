# Codex setup connection

This includes read-only discovery plus profile-scoped bindings and explicit overrides. Codex remains
authoritative. Apply rechecks the preview fingerprint, writes only Realm settings, and produces a
receipt. Rollback restores the prior binding only while the current value still matches that receipt;
later user edits produce a conflict. Profile inheritance, refresh, and connection UI remain pending.

Discovery must use the operating-system home and `CODEX_HOME` independently of Realm's data home.
Native configuration, skills, and hook metadata are read through app-server inspection methods.
Supplemental skill roots are explicit; cached plugin versions are never guessed. Only allowlisted
metadata is returned. A successful configuration read is not an authentication or connectivity check.

Run `pnpm --filter @realm/server... install --frozen-lockfile --ignore-scripts`, then
`node scripts/validate-codex-setup.mjs`. This public-dependency test lane does not require the desktop's
private icon package. Every validator invocation writes candidate identity, result, and logs under
`.validation/`. The manifest covers discovery and binding transactions; passing it does not establish
profile inheritance, full desktop parity, or rendered UI readiness.

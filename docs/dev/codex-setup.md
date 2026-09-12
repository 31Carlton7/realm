# Codex setup discovery

This is the discovery slice of the linked Codex setup mechanism. Codex remains authoritative;
Realm will own only selected source bindings and explicit overrides. It does not implement apply,
rollback, profile inheritance, refresh, or a connection UI yet.

Discovery must use the operating-system home and `CODEX_HOME` independently of Realm's data home.
Native configuration, skills, and hook metadata are read through app-server inspection methods.
Supplemental skill roots are explicit; cached plugin versions are never guessed. Only allowlisted
metadata is returned. A successful configuration read is not an authentication or connectivity check.

Run `pnpm --filter @realm/server... install --frozen-lockfile --ignore-scripts`, then
`node scripts/validate-codex-setup.mjs`. This public-dependency test lane does not require the desktop's
private icon package. Every validator invocation writes candidate identity, result, and logs under
`.validation/`. The manifest is scoped to discovery and must grow with later setup slices; passing it
does not establish full desktop parity or rendered UI readiness.

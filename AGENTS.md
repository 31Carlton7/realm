# Realm agent guidance

Before designing, building, or substantially revising Realm product UI, documentation, or marketing
surfaces, read `design.md` completely and use it as the source of design judgment.

Keep literal values and implementation mechanics in the owning tokens, styles, and components. When
review feedback reveals a reusable design principle, add the judgment to `design.md`; when it reveals
a repeatable mechanical failure, add a test or deterministic check near the implementation.

## Code cleanup

- Run `bash scripts/check-dead-code.sh` after removing code and before review.
- For cross-file changes, run `graphify update .`, inspect callers and dependencies, and verify findings in current source and framework registrations.

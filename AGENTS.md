# Realm agent guidance

Before designing, building, or substantially revising Realm product UI, documentation, or marketing
surfaces, read `design.md` completely and use it as the source of design judgment.

Keep literal values and implementation mechanics in the owning tokens, styles, and components. When
review feedback reveals a reusable design principle, add the judgment to `design.md`; when it reveals
a repeatable mechanical failure, add a test or deterministic check near the implementation.

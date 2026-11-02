# Contributing to Realm

Realm is built in the open under the [MIT License](LICENSE). Bugs and ideas go in
[issues](https://github.com/31Carlton7/realm/issues/new/choose); changes go in pull requests.

## Report a bug or ask for a feature

- **From the app:** Help ▸ Report a Bug opens the bug form with your version filled in. Help ▸ Request a
  Feature opens the other one. Settings ▸ General ▸ About has the same links.
- **Check the known limitations first:** [realm.computer/docs/status](https://realm.computer/docs/status)
  lists what Realm doesn't do yet, and what has and hasn't run on Linux and Windows.
- **The server log** is `~/Realm/logs/server.log`, and `server.log.1` is the run before it. The lines
  around a bug are often the whole story. Read them before you paste them: they name your folders and
  sessions.

## Build it

You need Node.js 22.13 or newer and pnpm 10. The app is built and tested on macOS; the Linux and Windows
builds are previews, and the server and the `realm` command run anywhere Node does.

```sh
git clone https://github.com/31Carlton7/realm.git && cd realm
pnpm install
REALM_HOME=~/realm-dev REALM_ENABLE_FAKE_AGENT=1 pnpm dev
```

- `REALM_HOME` keeps your dev data out of `~/Realm`, where your own Realm keeps its spaces and sessions.
- `REALM_ENABLE_FAKE_AGENT=1` adds a Fake agent to the model picker. A session set to it echoes what you
  send, so you can work on sessions without signing in to Claude or Codex, and without spending anything.
- Without a Hugeicons Pro token, `pnpm install` skips the Pro pack and the app draws the free one, which
  has the same glyphs ([docs/dev/hugeicons.md](docs/dev/hugeicons.md)).

[docs/architecture](docs/architecture/README.md) is the map: every process, every package, and each
feature followed through them.

## Before you open a pull request

- **Run the tests near your change:** `pnpm vitest run <paths>`. `pnpm test` runs all of them, and takes a
  while.
- **Typecheck:** `pnpm typecheck`, which runs each package's own `tsc --noEmit`. Don't run `tsc -b` on
  `apps/desktop/tsconfig.json`: it writes `.js` and `.d.ts` files next to the sources.
- **Lint:** `pnpm lint` runs Oxlint, which CI also runs.
- **Before a push,** a hook in `.githooks/` (which `pnpm install` turns on) checks the commits you're
  pushing for whitespace errors and conflict markers, lints, and typechecks each package they change. It
  takes a few seconds. Skip it for one push with `git push --no-verify`, or for all of them with
  `REALM_SKIP_PRE_PUSH=1`.
- **For anything you can see,** read [design.md](design.md) first. Check the change in the built app, in
  both the dark and the light theme, and put screenshots of both in the pull request.
- **One change per pull request,** with a title that says what changes for someone using Realm.
- **Commit messages** are one plain sentence about that change, such as "Let a teammate message another
  teammate", with no `feat:` or `fix:` prefix.

What you contribute is released under the MIT License, as the rest of Realm is.

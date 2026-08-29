---
name: mac
description: Use when a task touches this Mac's own apps — Calendar events, Reminders, Contacts, Mail, iMessage, Notes, Music, TV, Shortcuts, Finder selection/trash, or Keynote/Pages/Numbers documents. `mac` is a local CLI that drives them with `--json` output and stable exit codes; reach for it instead of AppleScript, `osascript`, or `open`.
---

# mac — the macOS app CLI

`mac` is a local Swift binary (v0.6.0, `/opt/homebrew/bin/mac`) that drives fifteen native macOS
apps from the shell. Calendar, Reminders, and Contacts go through EventKit/Contacts natively;
everything else through AppleScript, plus a read-only copy of the Messages database.

Run it with your normal shell tool. There is no MCP server and no wrapper — `mac` *is* the interface.

## The contract

- **`--json` on every command.** Sorted keys, ISO 8601 dates, stable schemas. Always pass it when
  you intend to parse. `--json` prints even under `--quiet`.
- **Exit codes.** `0` success · `1` not found or bad input · `2` **permission denied** (see below)
  · `64` malformed invocation (unknown flag, missing required option). `1` is reserved for semantic
  failures, so `64` means *you* got the command wrong and re-reading `--help` will fix it.
- **Mutations take exact IDs only.** `edit`, `delete`, `complete`, `mark-read`, `archive` never
  accept a name or a fuzzy match. Always `list`/`find`/`search` first and carry the `id` through.
- **Errors are one-line and actionable, on stderr.** Read them; they usually name the fix.
- **Discovery is in the binary.** `mac <group> <command> --help` prints usage *with examples* for
  every leaf. Prefer that over guessing flags — this file deliberately does not mirror the whole
  surface, because `--help` is authoritative and never goes stale.

## Command surface

| Group | Commands |
|---|---|
| `calendar` | `list` `add` `edit` `delete` `calendars` |
| `reminders` | `list` `add` `complete` `edit` `delete` `lists` |
| `contacts` | `find` `show` `add` `edit` `delete` |
| `mail` | `unread` `search` `read` `draft` `send` `mark-read` `archive` `accounts` |
| `messages` | `chats` `history` `send` |
| `notes` | `list` `search` `read` `add` `append` `edit` `delete` `folders` |
| `music` | `now` `play` `pause` `next` `prev` `volume` `search` `playlists` `playlist-create` `playlist-add` `playlist-remove` `playlist-delete` `rate` |
| `tv` | `now` `pause` `resume` `list` `play` |
| `shortcuts` | `list` `run` |
| `finder` | `selection` `reveal` `open` `trash` `disks` `eject` |
| `keynote` / `pages` / `numbers` | `docs` `new` `export` (+ `add-slide`/`slides`, `get-body`/`set-body`/`append`, `get-cell`/`set-cell`) |
| `call` / `facetime` | `mac call "+1 555 123 4567"`, `mac facetime user@example.com --audio` |
| `doctor` | permission audit — see Permissions |

Dates accept ISO (`2026-08-27 14:00`), naturals (`tomorrow 2pm`, `friday`), and offsets
(`+7d`, `+2h`).

```sh
mac calendar list --from today --to +7d --json
mac calendar add "Dentist" --at "tomorrow 2pm" --duration 1h --calendar Personal --json
mac reminders list --list Groceries --due-before friday --json
mac reminders add "File taxes" --due "friday 9am" --priority high --json
mac contacts find "Sarah" --json
mac notes search "brunch" --limit 10 --json
mac mail unread --account Work --limit 10 --json
mac finder trash ~/Downloads/old-draft.pdf --json
mac shortcuts run "Get Weather" --json
```

A two-step mutation, which is the shape almost every write takes:

```sh
mac reminders list --list Groceries --json     # -> [{"id":"x-apple-reminderkit://…", "title":"Buy milk", …}]
mac reminders complete "x-apple-reminderkit://…" --json
```

## Permissions — what exit 2 means

macOS TCC gates Calendar, Reminders, and Contacts, and gates AppleScript control of Mail, Messages,
Notes, Music, TV, Shortcuts, Finder, and the iWork apps under "Automation". Reading iMessage
history additionally needs Full Disk Access.

Three facts that determine how you should handle a denial:

1. **The grant belongs to the calling application, not to `mac`.** TCC attributes the request to the
   app that owns the process tree — the terminal emulator, or the app hosting the session. A grant
   made in one terminal does **not** carry into another app's shell. The same binary can work in one
   session and be denied in the next.
2. **A denial is sticky and silent.** Once denied, re-running does not re-prompt. Retrying is
   guaranteed to fail. Nothing you can do from the shell fixes it.
3. **`mac doctor` never prompts and always exits 0.** So check the `status` field, not the exit
   code:

```sh
mac doctor --json
# [{"capability":"calendar","status":"notRequested","fix":"Run any `mac calendar` command to trigger the macOS permission prompt."},
#  {"capability":"automation:Messages","status":"granted"},
#  {"capability":"fullDiskAccess","status":"granted"}, …]
```

Statuses are `granted`, `denied`, `notRequested`, and `unknown` (an Automation target that has never
been launched — open the app once and re-run). Entries that need action carry a `fix` string.

**On exit 2, stop and tell the user.** Do not retry, do not fall back to `osascript` (it hits the
same gate). Run `mac doctor --json`, quote the failing capability's `fix`, and name the toggle:
System Settings → Privacy & Security → **Calendars / Reminders / Contacts / Automation / Full Disk
Access** → enable the entry for the app running this session. `notRequested` is different and worth
saying out loud: the first real command will raise a macOS dialog the user has to click, so a
command may appear to hang while it waits for them.

## Gotchas worth knowing before you run

- **`mac mail draft`, not `mac mail send`,** unless the user explicitly asked to send.
- **`mac messages send` takes an exact handle** and does no name resolution — go through
  `mac contacts find` first. **A success is not proof of delivery**; Messages accepts sends to
  handles that were never registered. Verify with `mac messages history`.
- **Mail reads are windowed** to the newest `--scan` messages per account (default 30) — older mail
  is invisible. Raise `--scan` (max 500), but cost scales with messages touched: ~0.15 s/message on
  a small account, ~1.5 s/message on a 50k one. Without `--account`, `mail unread` is a fast sample,
  not a global newest-N.
- **Recurring calendar events share one ID** across occurrences; `edit`/`delete` hit the series
  master, not the one occurrence the user meant. Say so before deleting.
- **No clear-to-nil.** Edit flags replace values; a due date once set cannot be removed. Notes,
  location, and org can be blanked with an empty string. Titles cannot.
- **`mac finder trash` is the recoverable delete** — prefer it over `rm` for user files. `finder` is
  trash-only by design and reflects GUI state (selection, reveal, disks); for bulk or scripted file
  work use the shell.
- **`mac music search` sees the local library, not the Apple Music catalog.**
- **iWork commands address documents that are OPEN, by name** (`mac keynote docs`) — there is no
  open-by-path. Edits are text-only, `export` refuses to overwrite without `--force`, and
  `numbers get-cell` reads back as text (`42` comes back `42.0`).
- **`mac shortcuts run` blocks** until the shortcut finishes; one that shows a dialog will hang.
- **`mac call` / `mac facetime` only open a URL** — macOS still asks the user to confirm. `--dry-run`
  prints the URL without opening it.
- Duplicate calendar/list/folder names resolve to the first match; pass `--account` where offered.
- Password-protected notes list but read as empty. Group chats are read-only.

## When not to use it

Scripted or bulk file operations (use the shell), anything on a remote machine, and apps `mac` does
not cover — Photos, Preview, Maps, Books, Passwords and friends. For those, the escape hatch is a
Shortcut: `mac shortcuts list`, then `mac shortcuts run "<name>"`.

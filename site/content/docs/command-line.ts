import { careful, code, h2, h3, note, p, page, table, tip, ul } from "@/lib/docs-blocks"

// Read from apps/server/src/ctl/ and apps/server/bin/realm on feat/orchestrator-bench (PR #219), and checked
// against a server built from that branch: every output below is the shape the command prints.
// TODO(owner): once the command line ships, name its release in the note at the top, and point the source
// build at main instead of the feat/orchestrator-bench branch.
export default page({
  slug: "command-line",
  title: "Command line",
  summary:
    "The `realm` command runs Realm's agent server without a window and drives it from a shell or a script: open a repository, give each task a worktree of its own, run a command in each, and read how every one ended.",
  body: [
    note("The command line is new, and comes with the next release of Realm, after 2.4. Until then, build it from source, as below."),
    p(
      "`realm` talks to the same server Realm's window talks to, so a script and the window see the same spaces, worktrees and terminals. A command started with `realm run` shows in the sidebar as a terminal, and a worktree it makes is one the window can review. Every command can print one JSON document instead of text, and its exit code says how it went.",
    ),

    h2("Install"),
    p(
      "On a Mac, `realm` is inside Realm.app and runs on the app's own runtime, so it needs nothing else installed. Link it into a folder on your `PATH`, such as `/usr/local/bin`:",
    ),
    code(
      `ln -s /Applications/Realm.app/Contents/Resources/server/bin/realm \\
  /usr/local/bin/realm`,
      "Terminal",
    ),
    p("To build it from source you need Node.js 22.13 or newer and pnpm 10. These commands build Realm's server alone, which needs only public npm packages:"),
    code(
      `git clone --branch feat/orchestrator-bench https://github.com/31Carlton7/realm.git
cd realm
pnpm install --filter "@realm/server..."
pnpm --filter @realm/server build
apps/server/bin/realm help`,
      "Terminal",
    ),
    p("Outside Realm.app, the `realm` script runs on the `node` on your `PATH`."),

    h2("Which server it talks to"),
    p(
      "Every command except `serve` talks to the server running on a Realm home: the one `--home` names, or `$REALM_HOME`, or `~/Realm`. It finds that server's port and token in the home's `daemon.json`, which only your account can read. While Realm is open, that's the app's own server, and you don't need `realm serve`.",
    ),
    p("When no server is running on the home, a command exits with 1 and says so: `no Realm server is running on /Users/you/Realm`."),
    h3("Run the server without a window"),
    p(
      "`realm serve` runs Realm's agent server in the foreground, with no window, until you stop it with [[⌃C]] or `SIGTERM`. Stopping it also ends any command its terminals are still running. It listens only on `127.0.0.1`, on a port the system picks unless you give `--port`, and prints one line once it's ready:",
    ),
    code(`{"type":"ready","port":53817,"home":"/Users/you/realm-tasks"}`, "Terminal"),
    p(
      "It's the whole server, the one the app runs: on a home with scheduled tasks or a team, they run on their clocks while it's up. One server runs per home, so on a home that already has one, such as `~/Realm` while Realm is open, `serve` prints `ALREADY_RUNNING` and exits with 3. A script that wants its spaces kept apart from yours can have a home of its own, with `--home` or `REALM_HOME`.",
    ),

    h2("Commands"),
    table(
      ["Command", "What it does"],
      ["`realm serve [--port N]`", "Runs Realm's agent server here, without a window, until you stop it."],
      ["`realm status`", "Says whether a server is running on the home, with its version."],
      ["`realm repo add <path>`", "Opens a folder as a project, in a new space named after the folder. Run it again and it answers with the same space and project."],
      ["`realm worktree create <repo> <name> [--base REF]`", "Makes a worktree of `<repo>` on a new branch, `realm/<name>`, starting from `REF` or from the commit the checkout is on."],
      ["`realm worktree list <repo>`", "Lists the worktrees in `<repo>`'s space, each with its id, branch and path."],
      ["`realm worktree remove <id> [--force]`", "Deletes a worktree and its branch. `--force` deletes it even with uncommitted files or unpushed commits, and they go with it."],
      ["`realm run <repo> [--worktree NAME] [--base REF] -- <command>`", "Starts a command in a new terminal, in the checkout, or in a new worktree with `--worktree`. Prints the terminal's id and returns at once."],
      ["`realm ps`", "Lists every terminal the server has started since it began, and how each one ended."],
      ["`realm wait [<terminal>…] [--timeout S]`", "Waits until the terminals named, or all of them, have ended, then prints how each one ended."],
      ["`realm logs <terminal>`", "Prints what a terminal has printed so far."],
      ["`realm kill <terminal>`", "Stops a terminal's command and closes the terminal."],
      ["`realm help`", "Prints the list of commands."],
    ),
    p("Two options work with every command:"),
    table(
      ["Option", "What it does"],
      ["`--home DIR`", "The Realm home to use, with its server, spaces and worktrees. Without it, `$REALM_HOME`, then `~/Realm`."],
      ["`--json`", "Prints one JSON document on stdout instead of text, errors included. It has to come before `--`: after it, it belongs to your command."],
    ),

    h2("Run a command"),
    p("Everything after `--` is the command to run:"),
    ul(
      "One argument is a shell command line, run exactly as written, so quotes, `&&` and `;` work: `-- \"npm test && npm run lint\"`.",
      "Several arguments are quoted and joined into one command line: `-- claude -p \"Fix the login bug\"`.",
    ),
    p(
      "The command runs in your login shell, so it has the `PATH` your own terminal has, and its terminal ends when it does. In a space with a [sandbox](/docs/permissions#the-sandbox), it runs inside the sandbox.",
    ),
    p(
      "With `--worktree NAME`, Realm first makes a worktree on a branch of its own, `realm/NAME`, under `~/Realm/worktrees/`, starting from `--base` or from the commit the checkout is on. A name that's taken gets `-2`, then `-3`. Every checkout, the repository's own included, has a block of ten ports, which the command gets as `PORT`, `REALM_PORT_BASE`, `REALM_PORT_COUNT` and `REALM_PORT_END`, so six dev servers don't all ask for port 3000.",
    ),
    p("`run` returns as soon as the command has started, and prints the terminal's id, its branch and its path:"),
    code(
      `$ realm run ~/code/shop --worktree login-bug -- claude -p "Fix the login redirect loop"
01M5P8GCQE5X44PTAZ7A7R5RDC  realm/login-bug  /Users/you/Realm/worktrees/01M5P8GCGC73JQSG0K38KANJMW/login-bug`,
      "Terminal",
    ),

    h2("See how they ended"),
    p(
      "`realm ps` lists every terminal the server has started since it began, with where it runs, what it runs and how it ended: `running`, `exited` with the exit code, or `killed` with the signal that ended it.",
    ),
    p(
      "`realm wait` waits until the terminals you name have ended, or every terminal `ps` lists when you name none, or until `--timeout` seconds have passed, and prints how each one ended. Its exit code is the answer: 0 when every one exited 0, 1 when any failed or was killed, and 124 when the timeout came first.",
    ),
    careful(
      "With no terminals named, `wait` includes every terminal on the server, the shells you opened in Realm's window too, and those don't end on their own. In a script that shares a home with the window, name the terminals `run` gave you.",
    ),
    ul(
      "A command killed by a signal can still report exit code 0, the way shells report it. `wait` counts a command as succeeded only when it exited 0 with no signal, and a script reading `--json` should check `signal` as well.",
      "`realm logs <terminal>` prints what the terminal has printed so far.",
      "`realm kill <terminal>` stops the command and closes its terminal. A closed terminal leaves `ps`, and a later `wait` doesn't count it.",
      "How each command ended is kept in memory by the server that ran it. If that server restarts, `ps` lists only the terminals that came back, as plain shells, and a command that was running isn't started again.",
    ),

    h2("Remove a worktree"),
    p(
      "`realm worktree list <repo>` gives each worktree's id. `realm worktree remove <id>` deletes the worktree's folder and its branch. While the worktree has uncommitted files or unpushed commits, it refuses and says how much would be lost: `realm/login-bug has 1 uncommitted file; removing it destroys that work`.",
    ),
    p(
      "`--force` removes it anyway, and that work with it. Removal is refused outright while a session runs in the worktree, and for any checkout Realm didn't make. The space's [Worktrees tab](/docs/spaces-and-worktrees#the-worktrees-tab) lists the same worktrees, and can keep a branch when it removes one.",
    ),

    h2("A worked example"),
    p(
      "Six tasks for one repository, each in a worktree of its own, all running at once on a Realm home of their own. The tasks run Claude Code's print mode, allowed to edit files; its CLI has to be on your `PATH` and signed in. Any other command line works the same way.",
    ),
    p("Start a server on a new home, and wait until it answers. The commands after it use that home too, through `REALM_HOME`:"),
    code(
      `$ export REALM_HOME=~/realm-tasks
$ realm serve > ~/realm-tasks.log 2>&1 &
$ until realm status > /dev/null 2>&1; do sleep 0.2; done`,
      "Terminal",
    ),
    p("Open the repository as a project. It's safe to run again:"),
    code(
      `$ realm repo add ~/code/shop
/Users/you/code/shop is project shop in space shop`,
      "Terminal",
    ),
    p(
      "Start the six tasks, one line of `tasks.txt` each: a name for the worktree, then what to do. Each `run` returns as soon as its command starts, so all six are running within a second:",
    ),
    code(
      `$ cat tasks.txt
login-bug   Fix the login redirect loop
search-api  Add paging to /api/search
billing     Show the VAT line on invoices
dark-mode   Follow the system's dark mode
docs        Document the webhook retries
flaky-test  Find out why cart.test.ts times out
$ while read -r name task; do
>   realm run ~/code/shop --worktree "$name" -- \\
>     claude -p "$task" --permission-mode acceptEdits
> done < tasks.txt
01M5P8GCQE5X44PTAZ7A7R5RDC  realm/login-bug  /Users/you/realm-tasks/worktrees/01M5P8GCGC73JQSG0K38KANJMW/login-bug
01M5P8GCR3J2HFDKB36R34G46Q  realm/search-api  /Users/you/realm-tasks/worktrees/01M5P8GCGC73JQSG0K38KANJMW/search-api
01M5P8GCR5MGKG9GMVXY667G6T  realm/billing  /Users/you/realm-tasks/worktrees/01M5P8GCGC73JQSG0K38KANJMW/billing
01M5P8GCR87MEZM2R2QEQ0332T  realm/dark-mode  /Users/you/realm-tasks/worktrees/01M5P8GCGC73JQSG0K38KANJMW/dark-mode
01M5P8GCRB3REX5S0FNE10Y5ZH  realm/docs  /Users/you/realm-tasks/worktrees/01M5P8GCGC73JQSG0K38KANJMW/docs
01M5P8GCRFQQMPHPC473BSX6KB  realm/flaky-test  /Users/you/realm-tasks/worktrees/01M5P8GCGC73JQSG0K38KANJMW/flaky-test`,
      "Terminal",
    ),
    p("Wait up to an hour for them. Here five have finished and one is still going when the hour is up, so `wait` exits with 124:"),
    code(
      `$ realm wait --timeout 3600
01M5P8GCQE5X44PTAZ7A7R5RDC  exited 0
01M5P8GCR3J2HFDKB36R34G46Q  exited 0
01M5P8GCR5MGKG9GMVXY667G6T  exited 0
01M5P8GCR87MEZM2R2QEQ0332T  exited 0
01M5P8GCRB3REX5S0FNE10Y5ZH  exited 0
01M5P8GCRFQQMPHPC473BSX6KB  running
$ echo $?
124`,
      "Terminal",
    ),
    p("Read what one of them reported. In print mode, Claude Code prints its answer when it finishes:"),
    code(
      `$ realm logs 01M5P8GCQE5X44PTAZ7A7R5RDC
Fixed the redirect loop: /login no longer needs a session. Tests pass.`,
      "Terminal",
    ),
    p("Stop the one that's still going. Its terminal closes and leaves the list, so waiting again counts only the other five:"),
    code(
      `$ realm kill 01M5P8GCRFQQMPHPC473BSX6KB
closed 01M5P8GCRFQQMPHPC473BSX6KB
$ realm wait
01M5P8GCQE5X44PTAZ7A7R5RDC  exited 0
01M5P8GCR3J2HFDKB36R34G46Q  exited 0
01M5P8GCR5MGKG9GMVXY667G6T  exited 0
01M5P8GCR87MEZM2R2QEQ0332T  exited 0
01M5P8GCRB3REX5S0FNE10Y5ZH  exited 0
$ echo $?
0`,
      "Terminal",
    ),
    p(
      "Each task's changes are in its own worktree, on its own branch, `realm/login-bug` and the rest, to review and merge with git. `realm worktree remove` takes a worktree away when you're done with it, and `kill %1` stops the server you started.",
    ),
    tip(
      "With Realm open, leave `REALM_HOME` alone: the same commands use the app's server, and the terminals show in its sidebar. Name their ids to `wait` then, as the script below does.",
    ),

    h2("In a script"),
    p(
      "With `--json`, every command prints one JSON document on stdout. This script runs every line of `tasks.txt`, keeps the ids `run` gives back, and waits for exactly those terminals:",
    ),
    code(
      `#!/bin/sh
repo=~/code/shop
ids=
while read -r name task; do
  id=$(realm --json run "$repo" --worktree "$name" -- \\
    claude -p "$task" --permission-mode acceptEdits | jq -r .terminalId)
  ids="$ids $id"
done < tasks.txt

realm wait $ids --timeout 3600
case $? in
  0) echo "every task exited 0" ;;
  124) echo "a task was still running after an hour" ;;
  *) echo "a task failed or was killed" ;;
esac`,
      "run-tasks.sh",
    ),
    p("What each command prints with `--json`:"),
    table(
      ["Command", "With `--json`, prints"],
      ["`status`", "`running`, `realmHome`, `version` and `bootId`"],
      ["`repo add`", "`spaceId`, `projectId`, `environmentId` and `path`"],
      ["`worktree create`", "`environmentId`, `spaceId`, `path` and `branch`"],
      ["`worktree list`", "An array, each with `environmentId`, `path` and `branch`"],
      ["`worktree remove`, `kill`", "`{\"ok\":true}`"],
      ["`run`", "`terminalId`, `spaceId`, `environmentId`, `path` and `branch`, which is null without `--worktree`"],
      ["`ps`, `wait`", "An array of terminals, each as below"],
      ["`logs`", "`output`: what the terminal has printed"],
    ),
    p("Each terminal looks like this, spaced out here. `command` is null for a shell opened in the window, the times are milliseconds since 1970, and `exitCode` and `signal` are null while it runs:"),
    code(
      `{
  "terminalId": "01M5P8GCQE5X44PTAZ7A7R5RDC",
  "spaceId": "01M5P8GCGC73JQSG0K38KANJMW",
  "cwd": "/Users/you/Realm/worktrees/01M5P8GCGC73JQSG0K38KANJMW/login-bug",
  "command": "claude -p 'Fix the login redirect loop'",
  "running": false,
  "exitCode": 0,
  "signal": null,
  "startedAt": 1792822260822,
  "exitedAt": 1792822904113
}`,
      "One terminal, as ps and wait print it",
    ),
    p(
      "A failure prints `{\"error\":{\"code\":…,\"message\":…}}` instead, on stdout with `--json`, and one line on stderr without it. These are the codes a script is most likely to meet:",
    ),
    table(
      ["Code", "Means"],
      ["`NOT_RUNNING`", "No server is running on the home, or it didn't answer."],
      ["`USAGE`", "The command line was wrong, and the exit code is 2."],
      ["`NOT_FOUND`", "No terminal or worktree has that id."],
      ["`INVALID_PARAMS`", "That isn't an id at all: Realm's ids are 26 characters long."],
      ["`NOT_A_REPOSITORY`", "Worktrees need a git repository, and this folder isn't one."],
      ["`WORKTREE_NO_COMMITS`", "The repository has no commits yet to branch from."],
      ["`WORKTREE_BAD_BASE`", "`--base` names no branch or commit in the repository."],
      ["`WORKTREE_UNSAFE`", "The worktree has uncommitted files or unpushed commits. `--force` removes it anyway."],
      ["`ENVIRONMENT_IN_USE`", "A session still runs in the worktree."],
    ),

    h2("Exit codes"),
    table(
      ["Code", "When"],
      ["`0`", "It worked. For `wait`: every terminal it waited for exited 0, with no signal."],
      ["`1`", "It failed, and said why: no server on the home, or the server refused. For `wait`: a terminal exited with another code, or was killed by a signal."],
      ["`2`", "The command line was wrong: an unknown command, a missing argument, nothing after `--`, or no command at all."],
      ["`3`", "`serve` only: a server is already running on that home."],
      ["`124`", "`wait` only: the timeout passed with a terminal still running."],
    ),
    p("`serve` runs until it's stopped, and then exits with 0."),

    h2("What it doesn't do yet"),
    ul(
      "It runs commands, not Realm sessions. An agent started with `realm run` is a program in a terminal, with no transcript, permission cards or checkpoints in Realm. Starting a session, sending it a message and answering its requests are still done in the window.",
      "It has run on macOS and Linux, and not yet on Windows.",
      "How each command ended lasts only as long as the server that ran it.",
    ),
  ],
})

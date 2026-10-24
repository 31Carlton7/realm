import { h2, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

// Drawn from docs/architecture on main (README.md and features.md, written for 2.3.0) and checked against
// the v2.4.0 tree where the two differ: the iPhone app, its relay and packages/remote and view are in 2.4.0.
export default page({
  slug: "how-realm-is-built",
  title: "How Realm is built",
  summary:
    "The processes Realm runs on your computer, how they talk to each other and to your agents, where your data lives, and what reaches beyond your computer. The map in the repository goes further, file by file.",
  body: [
    p(
      "Realm is two processes on your computer, plus the agents they start. The window is an Electron app. Everything that has to outlive a window, such as sessions, terminals, schedules and the database, lives in a second process, Realm's agent server. The two talk over one local WebSocket, and the agents reach Realm's tools through one local MCP endpoint. Realm never sits between an agent and its model: each agent talks to its own provider, under your account.",
    ),

    h2("The processes"),
    table(
      ["Process", "What it does"],
      [
        "The app",
        "Electron 37, which is Chromium 138 and Node 22. It draws the windows and menus and owns everything native: browser panes, the Keychain and Touch ID, and the small Swift helpers that drive other apps on a Mac. It starts the agent server and is itself one of its clients.",
      ],
      [
        "The interface",
        "React, one renderer per window. It has no Node in it: it reaches the app through a narrow bridge, and the agent server directly, over the server's socket.",
      ],
      [
        "Browser panes",
        "Native web views the app owns, one per page. When an agent works in a page, the server asks the app, and the app drives the page through Chromium's DevTools protocol.",
      ],
      [
        "The agent server",
        "Holds all of Realm's state and does the work: sessions, terminals, worktrees, checkpoints, schedules, teams and connections. It runs on the app's own binary as Node. On a Mac it keeps running when the window closes, which is how agents keep working, and only **Quit Realm & stop agents** ends it. On Linux and Windows it's the app's child.",
      ],
      [
        "Agents",
        "Each agent is a process of its own, started by the server: Claude through the Claude Agent SDK, one `codex app-server` shared by every Codex session, and one process per session for the agents Realm runs over ACP.",
      ],
      ["Shells and tools", "Terminals are login shells the server owns. It also runs `git` and `gh`, and on a Mac the simulator and device tools."],
    ),

    h2("How they talk"),
    table(
      ["Between", "Over"],
      [
        "The interface and the server",
        "One WebSocket on `127.0.0.1`, opened with a token. The window calls the server, and the server pushes events, such as a transcript's new lines, to every window.",
      ],
      [
        "The app and the server",
        "The same socket. The app finds the server's port and token in `~/Realm/daemon.json`, which only your account can read. When the server needs something only the app can do, such as driving a page, it asks over that socket and waits for the answer.",
      ],
      ["The interface and the app", "Electron's IPC, through the bridge."],
      ["The server and an agent", "The agent's own protocol over stdio: the Agent SDK for Claude, JSON-RPC for Codex, the Agent Client Protocol for the rest."],
      [
        "An agent and Realm's tools",
        "MCP over HTTP on `127.0.0.1`, with a token made for that session. Realm's own tools and the space's connections are all behind that one endpoint, and Realm adds a connection's sign-in itself, so the agent never holds it.",
      ],
      ["A script and the server", "The `realm` command line, over the same socket as the window. See [Command line](/docs/command-line)."],
    ),
    p(
      "The server listens on your computer's loopback address only, on ports the system picks when it starts, and asks every caller for its token. Nothing on your network can reach it.",
    ),

    h2("Agents and adapters"),
    p("Every agent prints its work in its own format. An adapter for each protocol turns that into one kind of transcript, the one you read in a session:"),
    table(
      ["Agents", "How Realm runs them"],
      ["Claude", "Through the Claude Agent SDK, which runs the `claude` binary Realm ships"],
      ["Codex", "One `codex app-server` process, shared by every Codex session, spoken to in JSON-RPC"],
      ["Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code, Grok, fx, DeepSeek, OpenHands and Hermes", "The Agent Client Protocol (ACP), one process per session"],
    ),
    p(
      "Each adapter also maps Realm's permission modes onto what its agent understands, and turns the agent's requests into the cards you answer. See [Permissions and Full access](/docs/permissions).",
    ),

    h2("A turn"),
    steps(
      "You send a message, and the window hands it to the server. If a turn is already running, the message waits for it, or is steered into it.",
      "In a git checkout, the server takes a checkpoint first: a snapshot of every file, untracked ones included, kept in hidden refs in the repository under `refs/realm/checkpoints/`. Your branch, index and history aren't touched, and each checkout keeps its newest 50.",
      "It makes sure the agent is running, with Realm's MCP endpoint, the space's skills and its memory, and hands it the message.",
      "Every event the agent emits, such as text, a tool call or a request, becomes one of Realm's events: stored in `realm.db` and sent to every window. Streaming text is sent as it comes but not stored; the finished message is.",
      "When the turn ends, the server reads what changed from git, and sends the next queued message, if there is one.",
    ),
    p(
      "Restoring a checkpoint saves the checkout as it is first, as an undo point. A fork writes a checkpoint into a new worktree and starts a session there. See [Undo what a turn changed](/docs/sessions#undo-what-a-turn-changed).",
    ),

    h2("Worktrees"),
    p(
      "A worktree is a `git worktree add` under `~/Realm/worktrees/<space>/<name>`, on a branch of its own under `realm/`. One made before its session has a title starts as `realm/session`, and is renamed after the title once there is one, unless it's been pushed. Every checkout gets a block of ten ports, from 41000 up, handed to its terminals and agents as `PORT`, `REALM_PORT_BASE`, `REALM_PORT_COUNT` and `REALM_PORT_END`, so two checkouts of one app don't fight over a port.",
    ),
    p(
      "A worktree keeps agents' files apart. It isn't a security boundary: agents in different worktrees run as you, with your network and your files, unless the space has a [sandbox](/docs/permissions#the-sandbox), which is on a Mac only. See [Spaces and worktrees](/docs/spaces-and-worktrees#worktrees).",
    ),

    h2("What's on disk"),
    p("Everything Realm keeps is in one folder, `~/Realm`, or the one `REALM_HOME` names. Your code stays where it is."),
    table(
      ["In ~/Realm", "What it is"],
      ["`realm.db`", "One SQLite database: profiles, spaces, sessions and every transcript's events, schedules, runs and settings"],
      ["`daemon.json`, `daemon.lock`", "The running server's port, token and process, and the lock that keeps it to one server per home"],
      ["`secrets.json`", "Saved passwords and passkeys, and the keys that seal sign-ins kept in `realm.db`, all encrypted"],
      ["`worktrees/`", "The worktrees Realm made, a folder per space"],
      ["`logs/server.log`", "The agent server's log"],
    ),
    p("[Privacy and your data](/docs/privacy#where-realm-keeps-things) lists the rest, and what leaves your computer."),

    h2("The relay"),
    p(
      "Your iPhone never connects to your Mac directly. Both dial Realm's relay, a Cloudflare Worker with one Durable Object for each Mac, which passes on bytes it can't read. Pairing is a code carrying the Mac's public key and a one-time secret: the phone and the Mac run a Noise handshake through the relay, and your Mac asks you before it trusts the phone. Every connection after that is encrypted end to end against the keys pinned when you paired, and notifications are sealed on the Mac for the phone before they go through Apple's push service.",
    ),
    p(
      "With no iPhone paired and none being paired, the Mac doesn't connect to the relay at all. realm.computer carries one other thing: a sign-in for an app like Slack, which won't return to your computer directly, goes through a page there that only sends it back to Realm on your computer's loopback address, and keeps nothing.",
    ),

    h2("Where the code lives"),
    p("One repository holds all of it, in TypeScript apart from the Swift helpers and the iPhone app:"),
    table(
      ["Folder", "What it is"],
      ["`apps/desktop`", "The Electron app: its main process, the bridge, the React interface, the Swift helpers and the packaging"],
      ["`apps/server`", "The agent server: its socket, sessions, the MCP endpoint, every service, and the SQLite schema"],
      ["`apps/ios`", "Realm for iPhone, in SwiftUI"],
      ["`packages/adapters`", "One adapter per agent protocol"],
      ["`packages/contracts`", "Every shape that crosses between processes: the server's methods and events, and a session's events"],
      ["`packages/remote`", "The Mac's side of the iPhone's encrypted channel"],
      ["`packages/view`", "What the sidebar's **Needs you** and the iPhone's home have in common"],
      ["`packages/ui`", "Icons, themes and Realmites"],
      ["`services/relay`", "The relay"],
      ["`site`", "realm.computer, with these docs"],
    ),
    ul(
      "The repository's [architecture map](https://github.com/31Carlton7/realm/tree/main/docs/architecture) draws the whole system as one poster you can pan and zoom, and follows each feature through it file by file. It was drawn from Realm 2.3.0, before the iPhone app shipped.",
      "[Realm on Linux and Windows](https://github.com/31Carlton7/realm/blob/main/docs/platforms.md) lists everything that differs there, and why.",
      "Realm's source is [MIT-licensed](https://github.com/31Carlton7/realm/blob/main/LICENSE). A few bundled parts, such as the fonts, keep their own licenses.",
    ),
    note("This page describes Realm 2.4. [Status and known limitations](/docs/status) says what's still a preview, and what isn't done yet."),
  ],
})

import { h2, note, p, page, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "privacy",
  title: "Privacy and your data",
  summary:
    "Realm runs on your computer and keeps its data in one folder there. This is what it stores, where, what leaves your computer and why, and how your credentials are kept from your agents.",
  body: [
    h2("Where Realm keeps things"),
    p(
      "Everything Realm stores is in `~/Realm`, a folder in your home folder. (Set `REALM_HOME` before Realm starts to put it somewhere else.) Inside:",
    ),
    table(
      ["In ~/Realm", "What it is"],
      ["`realm.db`", "Your profiles, spaces and sessions, every transcript, your settings and your connections, whose sign-ins are stored encrypted. Transcripts are stored compressed."],
      ["`secrets.json`", "Saved passwords and passkeys, the key that encrypts connections' sign-ins, and this Mac's key for pairing an iPhone, all encrypted with a key macOS keeps in your login keychain. Only your account can read the file. Realm writes it all at once, and keeps one it can't read aside, unchanged, as `secrets.unreadable-….json`."],
      ["`library/`", "Realm's copies of the files in your Library, one folder per profile"],
      ["`worktrees/`", "The worktrees your sessions work in, one folder per space"],
      ["`skills/`, `commands/`, `memory/`", "Your skills, your own slash commands, and memory documents, including memory brought in from other agents"],
      ["`themes/`, `fonts/`", "Themes and fonts you added"],
      ["`keybindings.json`", "Your keyboard shortcuts"],
      ["`logs/`", "The agent server's log, and `credential-audit.log`: a line for every password fill, never the password"],
      ["`laya/`", "Laya's runtime, its decision log and your recordings, when Laya is installed"],
      ["`<profile>/<space>/`", "The folder of a space you made without choosing one"],
    ),
    p("A space with its own folder works in that folder, wherever it is. Realm adds nothing to your repository; its worktrees live under `~/Realm`, out of your `git status`."),

    h2("What leaves your Mac"),
    p("Realm is local-first: the app, its server and your data are on your computer. These are the things that go elsewhere, and only when they're used:"),
    table(
      ["What", "Where it goes"],
      ["What you send an agent", "That agent's own service (Anthropic for Claude, OpenAI for Codex, and so on), under your account, as if you used the agent yourself"],
      ["A connected app's tool calls", "That app's MCP server, through Realm's gateway"],
      ["Pages in the browser", "The sites you or your agents open"],
      ["Update checks", "Realm's releases on GitHub"],
      ["Laya's install", "Its packages and PyTorch from PyPI, and its model from Hugging Face"],
      ["Checking your agents for updates", "Each installed agent's package registry, every few hours"],
      ["Code review", "GitHub, through your own `gh`"],
      ["A Linux VM you start", "Its image, from Debian, Ubuntu or Alpine"],
      ["A font you add", "Google Fonts"],
      ["A text or Slack post when an agent needs you", "Messages on your Mac, or the Slack webhook you set, when you turn them on"],
      ["A paired iPhone's sessions and notifications", "Realm's relay, and Apple's push service for notifications. Both are encrypted on this Mac for the phone, so the relay and Apple carry nothing they can read. With no iPhone paired and none being paired, the Mac doesn't connect to the relay at all."],
    ),
    p(
      "Realm has no analytics or telemetry of its own. Its agent server listens only on your computer's loopback address, and asks every caller for a token.",
    ),
    note(
      "Signing in to Slack goes through a page on realm.computer, because Slack refuses a sign-in that returns straight to your computer. The page only redirects the sign-in back to Realm at your computer's loopback address, and stores nothing.",
    ),

    h2("Realm for iPhone"),
    p(
      "Realm for iPhone has no account and no analytics. It talks to your Mac, through Realm's relay, and to Apple's push service, and to nothing else.",
    ),
    table(
      ["What", "Where it goes"],
      ["Its keys, and each Mac's pairing", "The iPhone's keychain, on that phone alone: they're left out of backups and iCloud Keychain"],
      ["Home, the sessions you've opened, and messages not yet sent", "A cache on the phone, so they show at once"],
      ["What it sends your Mac, files included", "Encrypted end to end, through the relay, which keeps none of it"],
      ["The phone's name and model", "Your Mac, once, when you pair"],
      ["Its push token", "The relay, which deletes it when your Mac removes the phone"],
    ),
    ul(
      "**Forget <name>…**, in the phone's Settings, deletes its keys, the pairing and the cache. It forgets the Mac on that phone only: the Mac lists the phone until you remove it in **Settings ▸ Devices** there.",
      "The relay sees ids derived from each device's keys, when they connect, and from which IP addresses. It runs on Cloudflare.",
      "The camera is used only to scan the pairing code, and to take photos you choose to send.",
    ),

    h2("Your credentials and your agents"),
    ul(
      "**Connections.** An agent calls a connected app through Realm's gateway, and Realm adds the sign-in. The agent never receives the token. The environment variables and headers you type into an MCP server's form are kept in `realm.db` without encryption, so prefer a server's OAuth sign-in where it has one.",
      "**Passwords.** Agents can ask Realm to fill a saved password. A fill shows you a card, unless you've chosen **Always allow on this site**, and always asks for Touch ID or however your profile unlocks. The password never reaches the model or the transcript. See [The browser](/docs/browser#agents-and-your-passwords).",
      "**Secret files.** Realm won't hand an agent files that usually hold secrets, such as `.env` files, private keys and anything in `~/.ssh` or `~/.aws`, through `@` mentions.",
      "**Questions.** A form from an MCP server, Codex or another agent's own protocol asking you for a key or a password is declined without being drawn. When an agent asks through Realm's own question card, a secret field is masked and your answer is kept out of Realm's records.",
    ),

    h2("Your agents' own folders"),
    p(
      "Claude Code, Codex and the other agents keep their own settings and history in their own folders, such as `~/.claude` and `~/.codex`, as they would without Realm. **Settings ▸ Import** only ever reads those folders, and copies what you choose into `~/Realm`.",
    ),

    h2("Limiting what an agent can touch"),
    ul(
      "The [permission mode](/docs/permissions) decides what an agent does without asking.",
      "A space's [sandbox](/docs/permissions#the-sandbox) can stop its agents and terminals writing outside the space and reading your credential folders.",
      "Computer use is off until you switch it on for a space, and asks before each app. See [Computer use and Laya](/docs/computer-use).",
      "**Keep terminal scrollback** is off by default, because what a terminal printed can include secrets a command echoed.",
    ),

    h2("Removing data"),
    ul(
      "Archive a session from its row in the sidebar; **Settings ▸ Archived** restores or deletes it for good.",
      "**Delete space…** on a space's General tab deletes the space and its sessions.",
      "Remove a worktree from the space's Worktrees tab, which says first what would be lost.",
      "To remove everything, quit with **Quit Realm & stop agents** in the menu bar and delete `~/Realm`.",
    ),
  ],
})

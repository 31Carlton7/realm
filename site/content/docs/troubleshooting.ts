import { code, h2, h3, p, page, ul } from "@/lib/docs-blocks"

export default page({
  slug: "troubleshooting",
  title: "Troubleshooting and FAQ",
  summary: "What Realm's messages mean and what to do about them, and the questions people ask most.",
  body: [
    h2("An agent won't run"),
    h3("It says it isn't installed, or is signed out"),
    p(
      "When a session's agent can't run, a card takes the prompter's place. **Install** runs the install command and shows what it says. **Sign in** opens a terminal, runs the agent's own sign-in, and opens its sign-in page beside it; approving there is yours to do. **Open in terminal** types the command into the session's terminal for you to run. Realm checks again when you come back to the window, or press **Check again**.",
    ),
    p(
      "**Settings ▸ Engines** shows every agent's state and the exact command to install or sign in to it. Realm checks the agents again every 15 minutes on its own.",
    ),
    h3("Claude says its sign-in expired"),
    p("An expired Claude sign-in shows as an error in the transcript. Sign in again in a terminal, then send your message again:"),
    code("claude auth login", "Terminal"),
    h3("It stopped after a while"),
    p(
      "An agent left idle for 30 minutes is stopped to free its memory. Nothing is lost: your next message starts it again, and it picks up the conversation where it was.",
    ),
    h3("A Codex session won't start in one space"),
    p(
      "Codex sessions can't run in a sandboxed space in this release. Set the space's **Sandbox** to **No sandbox** to use Codex there. A session that can't get the sandbox it was asked for refuses to start rather than running without it.",
    ),

    h2("Messages at the top of the window"),
    ul(
      "**Connection lost — reconnecting…** The window lost its link to Realm's agent server for a moment. It reconnects on its own; **Retry** tries now.",
      "**The agent server stopped — restarting it…** Realm is starting its server again. Wait a moment.",
      "**The agent server keeps failing to start** Look at the log it names, `~/Realm/logs/server.log`.",
      "**Realm was updated, but the agent server running is the previous version.** Press **Quit & stop agents**, then open Realm again to finish the update.",
    ),

    h2("Computer use isn't working"),
    p(
      "If an agent can't drive an app, the prompter says so and offers **Allow in System Settings**. In **Settings ▸ Computer use**, both grants should read **Granted**. If one says it isn't honoured, which can happen after an update, press **Repair** and switch Realm on again in System Settings when it opens. Check, too, that computer use is switched on for the space you're in.",
    ),

    h2("Files and attachments"),
    ul(
      "Each attachment can be up to 20 MB. A larger one is refused with its size.",
      "A file an agent wrote outside the space, such as in `/tmp`, opens read-only.",
      "A browser download that isn't part of an action you allowed is stopped. **More ▸ Downloads** in that pane lists it, with **Save**.",
    ),

    h2("Closing and quitting"),
    p(
      "Closing the window or pressing [[⌘Q]] leaves your agents working, with Realm in the menu bar. To stop everything, choose **Quit Realm & stop agents** from that menu; it asks first if a session is still working. **Stop all agents** stops the agents and leaves Realm in the menu bar.",
    ),

    h2("Linux and Windows"),
    p(
      "The Linux (AppImage and .deb) and Windows builds of Realm 2.3 are previews. They are unsigned, so Windows SmartScreen warns on first run (choose **More info**, then **Run anyway**), and they don't update themselves: install a new version from the releases page. Features that exist only on a Mac, such as computer use, Laya, simulators, the Dock icon and window translucency, aren't shown there. On those systems Ctrl takes the place of [[⌘]] in every shortcut.",
    ),

    h2("A copy you built yourself"),
    p(
      "Releases are signed and notarized, so they open normally. A copy of Realm you built from source without signing it is quarantined when it's copied to another Mac. Open it the first time with right-click ▸ Open, and if macOS says it's damaged, clear the quarantine:",
    ),
    code("xattr -cr /Applications/Realm.app", "Terminal"),

    h2("Questions"),
    h3("Do I need an API key?"),
    p(
      "Not for Claude or Codex: you sign in with your own account, as you would to use the agent without Realm, and its usage counts against your plan. A few agents, such as Gemini and DeepSeek, take an API key in their own configuration instead.",
    ),
    h3("Can I use more than one agent?"),
    p(
      "Yes. Each session runs one agent, and you can have sessions on different agents side by side, in the same space. A session can also hand work to [sub-agents](/docs/sub-agents) on other agents' models.",
    ),
    h3("Does Realm see my code?"),
    p(
      "Realm runs on your Mac and keeps its data there. Your code goes where your agent sends it, which is its own provider, as it would without Realm. See [Privacy and your data](/docs/privacy).",
    ),
    h3("Where are my settings and history?"),
    p("In `~/Realm` on your Mac. [Privacy and your data](/docs/privacy#where-realm-keeps-things) lists what each file and folder holds."),
    h3("How do I see what changed in an update?"),
    p(
      "The first window after an update shows that version's notes. The gift button on the rail, and **Help ▸ What's New**, show them again, and the [changelog](/changelog) has every release.",
    ),
  ],
})

import { careful, figure, h2, h3, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "permissions",
  title: "Permissions and Full access",
  summary:
    "What an agent may do without asking you, how to answer when it asks, what Full access changes and what it never does, and the sandbox a space can put its agents in.",
  body: [
    h2("The permission chip"),
    p(
      "Beside the **+** in the prompter is a shield and a word: the session's permission mode. It's offered for Claude and Codex, the two agents Realm can set a mode on. From least to most trusting:",
    ),
    table(
      ["Mode", "What the agent does"],
      ["**Ask each time**", "Asks you before it edits a file or runs a command. New sessions start here unless you change it."],
      ["**Accept edits**", "Edits files without asking, and still asks before running commands. On Codex it behaves like Ask each time."],
      ["**Full access**", "Runs tools and edits files without asking first. The shield turns red so you can see it at a glance."],
    ),
    p(
      "Click the chip to change it. Choosing **Full access** asks you to confirm with **Allow everything? Confirm** before it takes effect. On Claude the change applies straight away; on Codex it applies from the session's next start.",
    ),
    p(
      "To change what new sessions start with, use **Settings ▸ General ▸ New sessions start in**. Each session's chip can still change it.",
    ),
    note(
      "Cursor and the other agents Realm connects to over the Agent Client Protocol keep their own permission modes, so their sessions have no chip. Realm shows their requests the same way, but it can't switch them into Full access.",
    ),

    h2("Answering a request"),
    figure(
      { crop: "permission-card" },
      "A permission card titled Allow Bash? with a Waiting tag. It shows the command pnpm vitest run settings, a Raw input disclosure, and three numbered options: Allow, Allow always and Deny. At the foot, Navigate, Select and a Submit button.",
      "A request to run a command, waiting in its session.",
    ),
    p(
      "When an agent wants to do something its mode doesn't cover, its session shows a card saying what it wants: the command it would run, the diff it would write, the page it would open. The card has three answers:",
    ),
    table(
      ["Answer", "Keys", "What it does"],
      ["**Allow**", "[[1]] or [[↩]]", "This once"],
      ["**Allow always**", "[[2]] or [[⇧↩]]", "This and the same request again, for the rest of the session or as the agent defines it"],
      ["**Deny**", "[[3]] or [[⌘⌫]]", "Refuse. [[Esc]] denies too."],
    ),
    p(
      "Requests show up wherever you're looking: under **Needs you** at the top of the sidebar (with **Answer here** to answer in place), as a count on the session's row, and as a notification when Realm isn't the app in front. **Settings ▸ Notifications** can also send them to you as a text message or a Slack post.",
    ),
    p(
      "For computer use, **Allow always** reads **Always allow in this space** and adds the app to the space's list. For a saved password, it reads **Always allow on this site**.",
    ),

    h2("What Full access does not change"),
    p("Full access skips the cards for ordinary work. A few things ask, or refuse, whatever the mode:"),
    ul(
      "**Saved passwords.** An agent filling one always shows its card, and Touch ID, or however your profile unlocks, still applies. See [the browser](/docs/browser#saved-passwords).",
      "**Typing passwords.** An agent can't type into a password field in a web page, or at a password prompt in a terminal, in any mode.",
      "**Other Mac apps.** Each app asks the first time in a space. Realm itself, System Settings, password prompts, Keychain Access and terminals can never be driven.",
      "**Real devices.** Driving a physical iPhone, iPad or Android device asks. Simulators don't.",
      "**Terminals the agent didn't open.** Reading or typing into one of yours asks.",
      "**A team's policies.** In a space with a team, its rules bind every session in the space, yours included.",
    ),
    careful(
      "Agents can't press the confirm, the permission card, a plan's approval or a question's answer themselves, and they can't change permission or sandbox settings. Only a click or a key of yours does those.",
    ),

    h2("Unattended work runs in Full access"),
    p(
      "Nobody is there to answer a card when a [scheduled task](/docs/scheduled-tasks) or a [team role](/docs/teams-and-review) runs, so those always run in Full access. A team's policies still ask and refuse for its roles, and anything a role wants to post outside Realm waits for you in Review.",
    ),
    p(
      "A [sub-agent](/docs/sub-agents) runs in its lead's mode, or a stricter one if the lead asked for less. A sub-agent of a Full access session has Full access; one of an Ask each time session asks, on its own card in the lead's Agents tab.",
    ),

    h2("The sandbox"),
    figure(
      { part: "sandbox" },
      "A space's Sandbox page. Under Posture, three options: Workspace write, Read only, and No sandbox, which is selected. Each has a sentence saying what agents and terminals may write.",
      "A space's three sandbox postures, on No sandbox, the default.",
    ),
    p(
      "A space can run its agents and terminals inside a macOS Seatbelt policy, set on the space page's **Sandbox** tab. Seatbelt isn't a container: it limits which files a process can read and write, but the process still shares your Mac. If Realm can't apply the policy, the session refuses to start rather than starting unprotected.",
    ),
    table(
      ["Posture", "What agents and terminals may do"],
      ["**Workspace write**", "Write only to this space's checkouts, their build caches, the agent's own state folder and a temp folder. `~/.ssh` and `~/.aws` can't be read, and files that make something run later, like `~/.zshrc` and `~/.gitconfig`, can be read but not changed."],
      ["**Read only**", "Write nothing but their own temp folder. Edits, installs and builds fail."],
      ["**No sandbox**", "Run as you, with everything your account can read and write. New spaces start here."],
    ),
    p(
      "The network stays open unless you untick **Allow network access**, which blocks every connection, and most agents can't run without reaching their own service. So the sandbox limits what a session can damage or read, not what it can send. Codex sessions can't be sandboxed in this release: in a sandboxed space a Codex session refuses to start, so set that space to No sandbox to use Codex there.",
    ),
    steps(
      "Open the space's page (**Space settings** in its menu) and choose **Sandbox**.",
      "Pick a posture. The page says whether this space follows the default or sets its own; **Use the default instead** goes back.",
      "Run a build in the space and check nothing you need is refused before you rely on it.",
    ),
    h3("Questions that aren't permissions"),
    p(
      "Agents also ask questions, which arrive as cards that say who is asking. Answering one grants nothing. A form from an agent or an MCP server that asks for a key or a password is declined without being shown to you: secrets reach a site through [saved passwords](/docs/browser#saved-passwords), and reach a connection through its own sign-in.",
    ),
  ],
})

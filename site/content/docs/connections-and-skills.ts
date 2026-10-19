import { figure, h2, h3, note, p, page, steps, table, tip, ul } from "@/lib/docs-blocks"

export default page({
  slug: "connections-and-skills",
  title: "Connections and skills",
  summary:
    "Give a space's agents your apps and tools through one MCP gateway that keeps your credentials out of their hands, and teach them how you work with skills.",
  body: [
    h2("How connections work"),
    p(
      "Connections belong to a space, not to an agent. Every session in the space gets one endpoint, Realm's MCP gateway, and through it the tools of every server the space has connected. When an agent calls a tool, it calls Realm, and Realm calls the server. The credentials a server needs stay with Realm and never reach the agent.",
    ),
    p("So one connection works for every agent you run in the space: Claude, Codex, Cursor and the rest all see the same tools."),

    h2("Connect an app"),
    figure(
      { part: "connections" },
      "The Connections page, Connect an app: cards for Linear, Notion, Slack, GitHub, Jira & Confluence, Figma and Sentry, each saying what it grants, with a Connect button and a link to the vendor's docs.",
      "The apps a space can connect in one click.",
      "Three of the apps a space can connect, each with what it lets an agent do.",
    ),
    p(
      "**Connections** on the rail starts with **Connect an app**: a card for each app whose own remote MCP server Realm can sign you in to. Press **Connect** and sign in on the app's own page. From then on it's an ordinary server in the list below.",
    ),
    table(
      ["App", "What its agents can do"],
      ["**Linear**", "Read and update issues, projects and cycles. Paste an issue link and the agent has it."],
      ["**Notion**", "Search and read pages and databases, and write back."],
      ["**Slack**", "Read channels and threads, search messages, post as you."],
      ["**GitHub**", "Issues, pull requests, code search and Actions on your repositories."],
      ["**Jira & Confluence**", "Jira issues and boards, Confluence pages, through Atlassian's own server."],
      ["**Figma**", "Read designs, components and variables straight from a file link."],
      ["**Sentry**", "Issues, stack traces and releases, so an error link is a starting point."],
    ),
    h3("Apps that need an app of your own"),
    p(
      "Slack doesn't hand out sign-in clients on the fly, so its card asks for the **Client ID** and **Client secret** of a Slack app you create, before it signs you in. The card lists the steps, including the redirect URL to add:",
    ),
    steps(
      "At api.slack.com/apps, create an app in your workspace (From scratch).",
      "Under OAuth & Permissions, add the redirect URL `https://realm.computer/oauth/callback`.",
      "Copy the Client ID and Client Secret from Basic Information into the card.",
      "Install the app to the workspace, or have an admin approve it.",
    ),
    note(
      "That redirect is a page on this site that only bounces the sign-in back to Realm on your own Mac. It never leaves your Mac's loopback address.",
    ),
    h3("GitHub"),
    p("GitHub's card connects with your GitHub CLI's sign-in if you have one, otherwise with a code you enter on GitHub, or a token you paste."),

    h2("Add any MCP server"),
    p("Under **MCP servers**, **Add server** connects any other server:"),
    table(
      ["Field", "For"],
      ["**Name**", "Letters, digits, underscore or hyphen"],
      ["**Transport**", "`stdio` for a program Realm starts, or `http` or `sse` for a server at a URL"],
      ["**Command** and **Arguments**", "The program to start (stdio)"],
      ["**URL**", "Where the server is (http, sse)"],
      ["**Authentication**", "**OAuth**, where the server offers it, or **API key headers**"],
      ["**Environment variables** or **Headers**", "Values the server needs, such as an API key"],
    ),
    p(
      "Each server's row shows its state and has **Test**, **Refresh tools**, **Edit** and **Remove…**. A server that exits, by crashing or quitting when idle, is connected again on its next call. One whose connection keeps failing has its calls blocked until **Retry** reconnects it, and one whose sign-in expired says **Needs reauth**.",
    ),
    p(
      "A server can be set up for **This space**, for every space in your profile (**From <profile>**), or **Everywhere**. **Move to profile…** and **Move to this space…** change that.",
    ),
    note(
      "OAuth sign-ins are kept encrypted, with the key in your keychain. The environment variables and headers you type into a server's form are stored in Realm's database on your Mac, not encrypted, so prefer OAuth where a server offers it.",
    ),

    h2("Realm's own tools"),
    p(
      "Realm gives every session tools of its own through the same gateway: the browser, terminals, documents, schedules, simulators, sub-agents, computer use and more. They run under Realm's permission rules, not as servers you configured. The list under **Realm's own tools** has a switch for each, for this space. Most are on by default; the ones that reach outside a pane Realm made (other Mac apps, another machine, Realm's own interface) start off.",
    ),

    h2("See every call"),
    p(
      "**MCP Activity** (**View ▸ MCP Activity**, the palette, or **Activity** beside the server list) lists every tool call that went through the gateway: which server and tool, how long it took, and whether it was blocked. In a transcript, a call to a connected app wears that app's mark.",
    ),
    tip(
      "Paste a link from a connected app (a Linear issue, a Notion page, a Slack thread) into the prompter, and where Realm can name what it points at, it becomes a chip with that name. The agent gets the link, and opens it through the connection.",
    ),

    h2("Skills"),
    p(
      "A skill is a folder with a `SKILL.md` in it: instructions, and any files they need, that teach an agent how to do one thing your way. Realm keeps your skills in `~/Realm/skills`, and can also read the folders you point it at.",
    ),
    ul(
      "**Library ▸ Skills**, or a space's **Skills** tab, lists every skill Realm found, each with a switch for this space. A skill's own page says whether it's **On in this space** or **Off in this space**.",
      "Like servers, a skill can belong to **This space**, your profile, or **Everywhere**.",
      "**Add a folder…** adds another place to look. **Where Realm looks for skills** lists every place and how many skills each holds.",
      "In a session, **+ ▸ Skills** turns one on, and `@` with a skill's name mentions it in a message.",
    ),
    p(
      "**How each agent uses them** on the skills page says what each agent does with a skill, since they don't all take them the same way. Codex reads skill folders per connection rather than per space, so a skill on in any space is visible to Codex sessions in every space.",
    ),
    p(
      "Realm ships a few skills of its own, such as the browsing playbook its browser agent follows. **Settings ▸ Import** copies the skills you already have in Claude Code, Codex and Cursor into Realm, without changing the originals.",
    ),
  ],
})

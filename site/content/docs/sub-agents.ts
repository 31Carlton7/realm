import { figure, h2, note, p, page, table, tip, ul } from "@/lib/docs-blocks"
import subAgents from "@/public/product/details/sub-agents.webp"

export default page({
  slug: "sub-agents",
  title: "Sub-agents",
  summary:
    "A session's agent can hand parts of its work to sub-agents, on its own model or any other you have, and you can watch, answer and steer each one from the session's Agents tab.",
  body: [
    p(
      "A sub-agent is a real session in the same space, started by your session's agent with a task of its own. The agent that started it, its lead, splits the work, waits for the reports and answers to you for the result. Every sub-agent's transcript is kept, so you can read exactly what it did.",
    ),
    figure(
      { part: "delegation" },
      "A session's Agents tab. Under Sub-agents, 1 needs you, 1 done: Dark-mode toggle on GPT-6 Luna through Codex is waiting on a permission card, Allow Bash?, with Allow, Allow always and Deny. Theme migration on Fable 5.1 through Claude is Done. Each card names its checkout, its mode and how much of its time budget it used. Below, Build with offers Claude Opus 5.5, Claude Fable 5.1 and GPT-6 Luna.",
      "One sub-agent waiting on a permission, one done, and Build with under them.",
      "One sub-agent waiting on a permission, and one done.",
    ),

    h2("Asking for sub-agents"),
    p(
      "Ask your agent in your own words: \"split this between three sub-agents\", or \"have GPT-6 Luna write the tests and Fable do the migration\". It starts them with Realm's tools and gives each a short title, which is what you'll see on its card.",
    ),
    ul(
      "**Any model you have.** A sub-agent can run on a different model from its lead, named the way you'd say it, and Realm runs it on the agent that has that model. Left unnamed, it runs on the lead's model.",
      "**Its own checkout.** Sub-agents working in parallel should each get a [worktree](/docs/spaces-and-worktrees#worktrees), and the lead can give them one. Otherwise they work in the space's own folder, or a checkout the lead names.",
      "**The space's tools.** A sub-agent has the space's connections and skills, and the lead can narrow its skills further.",
    ),
    p(
      "From the session's **Agents** tab you can also ask for this without typing the request yourself. **Build with** lists models; pick one or more, describe the plan or feature, and send it to the session's agent. **Split by model** gives each model its own part to write. The request still goes to your agent, which does the splitting.",
    ),

    h2("Watching them work"),
    p(
      "While sub-agents run, the transcript shows a line for each, such as **Sub-agent finished · Theme migration** with its model and time, and a strip at the foot of the transcript counts how many need you and how many are done. The session's **Agents** tab, in the side panel, has a card for each with:",
    ),
    ul(
      "where it stands (**Needs you**, working, **Done**) and for how long",
      "the model and agent it runs on, its checkout and its permission mode",
      "how much of its time budget it has used",
    ),
    figure(
      { detail: subAgents },
      "Two sub-agent cards: GPT-6 Luna through Codex, Needs you, building the dark-mode toggle and asking Allow Bash?; Claude Fable 5.1, Done, having written the migration with all twelve tests passing.",
      "Two sub-agents in the transcript, one waiting on you and one finished.",
    ),
    p(
      "Click a card, or a sub-agent's line in the transcript, to open it in the side panel: its live transcript, its state, what it was asked, and what it reported once it finishes. Its requests can be answered there; **Message this sub-agent** writes to it alone, **Stop** stops it, and **Open as session** opens it with its own prompter.",
    ),

    h2("Permissions"),
    p(
      "A sub-agent runs in its lead's [permission mode](/docs/permissions), or a stricter one if the lead asked for less. A lead in Full access starts sub-agents in Full access. A lead on Ask each time starts sub-agents that ask, and their requests appear on their cards in the lead's Agents tab, where you answer them; the lead's row in the sidebar counts them.",
    ),

    h2("Limits"),
    table(
      ["Limit", "Why"],
      ["Up to 4 sub-agents running at once per session, and 12 across Realm", "Each is a real agent with its own memory and often its own checkout"],
      ["A time budget per sub-agent, about 11 minutes by default", "Time spent waiting on you doesn't count. A sub-agent that runs out is stopped and reports what it had."],
      ["Sub-agents can't start sub-agents", "The lead stays the one who coordinates"],
    ),
    note(
      "If the lead gives up waiting for its sub-agents, they keep running under their own budgets until they finish or you stop them.",
    ),

    h2("The browser agent"),
    p(
      "One kind of sub-agent only browses. When a task is a sequence of steps on websites, the lead can hand it to a browser agent: a session whose only tools are Realm's browser tools, guided by Realm's browsing playbook, and limited to the sites the lead names if it names any. It opens its own pages in the side panel, which you can watch, and reports back when it's done. Like any sub-agent it can't start sub-agents, and it can't type a password, only ask to fill a [saved one](/docs/browser#saved-passwords).",
    ),
    tip(
      "Mentioning a teammate with `@` in a space that has a [team](/docs/teams-and-review) starts that role as a sub-agent of your session.",
    ),
  ],
})

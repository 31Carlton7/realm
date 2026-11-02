import { h2, h3, note, p, steps, table, ul, page } from "@/lib/docs-blocks"

export default page({
  slug: "teams-and-review",
  title: "Teams",
  summary:
    "Teammates are agents that stay in a space. Each one is a chat you message; it starts its own sessions for the work, talks to the other teammates, and can check in on a schedule.",
  body: [
    p(
      "A teammate is an agent with a name, a line about what it does, an icon, a model and a folder. It keeps one chat that you come back to, rather than a new session each time. Its chat is an ordinary session: replies stream, and its questions and permission cards are answered where they appear.",
    ),

    h2("Add a teammate"),
    steps(
      "In the sidebar, press **+** beside **Team** under the space. A space with no teammates offers **Add a teammate** on its page.",
      "Name it, and say what it does. The quick starts (**Lead**, **CTO**, **Design engineer**, **Research**, **Cleanup**, **TPM**) fill in a brief you can change.",
      "Pick its icon, its model, its folder and its permissions, and press **Create**. Its chat opens.",
    ),
    p(
      "A teammate's icon is one colour in one of eight shapes. It never changes with what the teammate is doing; the dot beside its name says that, in words as well as colour.",
    ),

    h2("Message a teammate"),
    p(
      "Click a teammate in the sidebar to open its chat, and write to it as you would in any session. For real work it starts a session of its own, named after itself and the task (`cto - sqlite search`), and tells you in a sentence or two, with a link to the session.",
    ),
    p(
      "Type `@` and a teammate's name in any prompter in the space to pass it a message from where you are.",
    ),

    h2("Its sessions and its computer"),
    p(
      "A teammate's sessions are listed under it in the sidebar; press the arrow beside its name to show them. Work it handed to another teammate is listed under the session that asked for it.",
    ),
    p(
      "Its chat opens with a **Computer** panel beside it: the Mac it runs on and whether it is working, with **Stop**; its **Files**, **Terminal** and **Simulator**, opened for its folder; and every session it started, newest first, with how long ago and a dot when one is unread.",
    ),

    h2("Teammates talk to each other"),
    p(
      "Every agent in a space with teammates has two tools for them:",
    ),
    table(
      ["Tool", "What it does"],
      ["`team_list`", "Lists the teammates: what each does, whether it is the Lead, whether it is idle, working or waiting on you, and what it is working on."],
      ["`team_message`", "Sends a teammate a message. It arrives in that teammate's chat, signed with the sender, after any turn it is in the middle of. With `wait`, the sender waits for the answer."],
    ),
    p(
      "A teammate cannot wait on itself, or on a teammate that is already waiting on it; the message is refused with a reason instead.",
    ),

    h3("The Lead"),
    p(
      "Make one teammate the Lead from its menu or when you add it. It sits first in the list, and it hands each ask to the teammate who fits, so you are not passing work between them yourself.",
    ),

    h2("Check in on a schedule"),
    p(
      "Turn on **Check in on a schedule** in a teammate's settings, choose when, and write what it should do. At those times the message arrives in its chat, which is marked unread until you read the answer. No window opens for it. A check-in still running after an hour is stopped, and one that comes due while the last is still going is skipped.",
    ),

    h2("Permissions"),
    ul(
      "A teammate runs in the permission mode you give it: **Ask each time**, **Accept edits** or **Full access**.",
      "The sessions it starts run in the same mode, so a teammate on Full access doesn't stop to ask in each of them.",
      "A teammate on **Ask each time** waits for you at its first permission card, including during a scheduled check-in.",
    ),

    note(
      "Teams before Realm 2.7 had Review batches, posting tickets, record pages, policies and a team vault. Those are gone; teammates and their schedules came across, and the old records are memory files you can read in Library ▸ Memory.",
    ),
  ],
})

import { code, figure, h2, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "scheduled-tasks",
  title: "Scheduled tasks",
  summary:
    "Realm can start an agent in one of your spaces on a clock you set, once or on repeat, and keeps every run on the Scheduled page to read and carry on.",
  body: [
    figure(
      { part: "schedules" },
      "The Scheduled page. On the left, New task, then Upcoming: Morning triage tomorrow at 9:00 AM on weekdays with GPT-6 Luna, Weekly numbers on Fridays with Opus 5.5 and its run from today at 11:30 AM selected, and Dependency sweep on Mondays with Sonnet 5. Under Suggested, Weekly review, Morning brief and Watch CI. In the middle, the selected run's transcript with a chart. On the right, the task's card: Fridays at 4:00 PM, its instructions, 1 output, the next run, its model, and its sources.",
      "Three tasks, a run of Weekly numbers open, and the task's card beside it.",
      "Three scheduled tasks, and today's run of Weekly numbers.",
    ),

    h2("Schedule a task"),
    steps(
      "Press **Scheduled tasks** on the rail, then **New task**.",
      "Give it a **Task name** and write its instructions. Write them for an agent that has never seen your conversation, because that's what a scheduled run is.",
      "Leave **Repeat task** on and choose how often, or turn it off to run it once at a date and time.",
      "Under **Advanced**, choose the **Space** it runs in and its **Model**, and whether each run starts a new session.",
      "Press **Create**.",
    ),
    table(
      ["Repeat", "Runs"],
      ["**Hourly**", "Every hour, at the minute you pick"],
      ["**Daily**", "Every day at a time"],
      ["**Weekdays**", "Monday to Friday at a time"],
      ["**Weekly**", "On one day a week at a time"],
      ["**Monthly**", "On one day of the month at a time"],
      ["**Custom (cron)**", "A five-field cron expression in your local time: minute, hour, day of month, month, weekday"],
    ),
    code("0 9 * * 1-5", "Custom (cron): 9:00 AM every weekday"),
    p("**Suggested** under the list offers three tasks worth having on a clock, ready to adjust: **Weekly review**, **Morning brief** and **Watch CI**."),
    p(
      "An agent can schedule one for you, too. Ask in a session, \"every Friday at 4, write up the week\", and its agent uses Realm's scheduling tool to create the task in that space. It reads the space's existing schedules first, so it doesn't make one you already have.",
    ),

    h2("Runs"),
    ul(
      "Each run is a session, and lands under its task on the Scheduled page rather than opening a pane beside whatever you're doing. A run you haven't read is marked unread until you open it.",
      "Runs work in Full access, since nobody is there to answer a permission card. If a run stops and asks for a person anyway, Realm tells you, as it does when a run finishes (**Settings ▸ Notifications**).",
      "By default each run starts a new session. Turn off **Start each run in a new session** and each run continues the last one's conversation instead.",
      "**Archive successful runs** keeps finished runs out of the sidebar. Failed and interrupted runs stay visible.",
    ),
    p(
      "Selecting a task shows its card: when it runs, its instructions, its outputs, the next run and its model, and the space's connections it can use under **Sources**. The card's **⋯** has **Run now**, **Pause** or **Resume**, and **Delete task…**; the pencil edits it.",
    ),

    h2("When your Mac is asleep or Realm is closed"),
    p(
      "Closing Realm's window, or [[⌘Q]], leaves Realm running in the menu bar, and schedules keep firing. Only **Quit Realm & stop agents** in the menu bar stops them.",
    ),
    table(
      ["If a run was due while…", "Then"],
      ["the Mac slept, and it wakes within 6 hours", "The run starts once, when Realm comes back"],
      ["the Mac slept for longer than that", "That run is skipped, and the task says so. A week of runs never all start at once."],
      ["it's a one-time task", "It runs as soon as it can, however late"],
    ),
    note(
      "Team roles use the same clock: a role's **Wakes** is a schedule like these, and a role whose week of budget is spent skips its run and records why. See [Teams and Review](/docs/teams-and-review).",
    ),
  ],
})

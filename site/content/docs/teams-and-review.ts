import { careful, h2, h3, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "teams-and-review",
  title: "Teams and Review",
  summary:
    "A team gives a space standing teammates: agents with a brief, a model, a clock and a budget. Their work comes to Review, and nothing leaves Realm until you approve it.",
  body: [
    p(
      "A team is a space with teammates in it. Each teammate, a role, is an agent with a brief that says what it does and for whom, a model, a clock it wakes on and a share of the team's weekly budget. A role runs on its own, and what it makes goes to **Review** for your yes before anything is posted, sent or emailed.",
    ),

    h2("Make a team"),
    steps(
      "Open the space's menu in the sidebar and choose **Make this a team…**. (The space page's **Team** tab is the same page.)",
      "Choose who's on it. Pick from the starter roles, or press **Custom teammate** to write your own.",
      "Press **Make <space> a team**. You can add, change or remove anyone later.",
    ),
    table(
      ["Starter role", "What it does"],
      ["**Researcher**", "Looks things up when you ask, and sends back a short brief with its sources."],
      ["**Editor**", "Reads drafts before they reach you and sends back what to fix. Rewrites nothing on its own."],
      ["**Growth Analyst**", "Reads the numbers the team watches and reports each Monday. Changes nothing."],
      ["**Community Manager**", "Reads comments and messages, and drafts the replies for your yes."],
      ["**Ops**", "Keeps the team's to-dos, deadlines and paperwork in order, and drafts what is due."],
      ["**Creator Manager**", "Keeps each creator's record, contract and deadlines. Drafts every message; sends none."],
      ["**Content Producer**", "Makes slideshows for each signed creator, and sends each batch to Review."],
    ),
    p(
      "Each role starts with a cap of $3 or 20 minutes a run. Dollars are what the runs would cost on the API; on a subscription they measure how heavy the work was, not a bill. A team keeps its memory in a folder of its own, outside your projects.",
    ),

    h2("A role"),
    p("A role's sheet holds everything about it:"),
    ul(
      "**Name** and **Realmite**, the small creature that marks it. Shuffle one, or make it part by part. Its face shows the role's state (idle, working, needs you, asleep), never a mood.",
      "**What they do**: the brief. Say what it does, for whom, and what it must never do.",
      "**Model**: the agent's default, or a model such as Opus, Sonnet or Haiku.",
      "**Wakes**: a clock, such as every weekday at 9:00 AM, or **Only when you run it**.",
      "**A week, at most ($)**: its share of the team's weekly budget. A role whose week is spent pauses until the next.",
      "**Skills**: the skills it may use.",
    ),
    p(
      "Roles always run in Full access, because nobody is there to answer a card when one wakes. The team's policies still ask and refuse for them, as below.",
    ),
    h3("Running a role"),
    ul(
      "**Run now** on its page starts a run on its brief.",
      "Message it from its page, or mention it with `@` in any session in the space, which starts it as a sub-agent of that session.",
      "It also wakes on its clock, and when you answer one of its reviews.",
    ),
    p(
      "Its page shows **Recent runs**, what each one did, and its cost and time. The sidebar folds a team's roles under the space, each with its Realmite.",
    ),

    h2("Review"),
    p(
      "What a role makes for your approval lands in the space's **Review**. While something waits, a **Review** row appears under the space in the sidebar, and it's counted under **Needs you**. Review lists work as **Waiting for you**, **Approved, not posted**, **Done this week** and **Closed this week**. Opening one shows the work itself, what Realm checked, and how it was made.",
    ),
    table(
      ["Action", "What happens"],
      ["**Approve**", "Accepts it. Anything to post, send or email is now ready, and each item still waits for its own press."],
      ["**Request changes**", "Asks **What should change?** and sends your note to the role, which wakes to make a new version"],
      ["**Reject…**", "Says no. If you give a reason, the role is told why."],
      ["**Close**", "Puts it away without sending any of it, and without telling the role. It also works after you've approved, and takes back anything not sent yet."],
    ),
    p(
      "After you approve something meant for outside Realm, it gets its own **Post…**, **Send…** or **Send DM…** button, which opens a sheet showing exactly what will go and from which account. **Hold posting** stops every post, email and DM of the team until you let them go.",
    ),
    careful("Nothing leaves Realm until you approve it, and even then each post, email or message waits for its own press."),

    h2("Policies"),
    p(
      "A team's **Policies** page sets what its agents may do, by kind of action (posts and messages, shell commands and web fetches, sign-ins and keys, connections), and for single tools. Each rule is one of:",
    ),
    table(
      ["Rule", "Meaning"],
      ["**Without asking**", "Goes ahead. Outward actions also need a daily limit."],
      ["**Ask each time**", "A card asks you first"],
      ["**You approve, then press each one**", "Goes to Review, and each one waits for its own press"],
      ["**Never**", "Refused"],
    ),
    p(
      "Reading and changing the space itself go ahead by default; anything that reaches outside it asks. The policies bind every session in the space, including yours, in every permission mode. No agent can change a policy.",
    ),

    h2("The vault"),
    p(
      "A team's **Vault** holds the sign-ins and API keys its roles may use: a password Realm types into a page, or a key Realm puts into one request to the hosts you name. For each entry you choose which roles may use it and whether they ask first. The agent never receives the value; Realm types or sends it itself, and every use is a line in the team's Activity and in Realm's credential log.",
    ),
    note(
      "The team's other pages are **Overview**, **Records** (what the team keeps, such as one record per creator), **Roles** and **Activity**, which lists everything the team did, newest first.",
    ),
  ],
})

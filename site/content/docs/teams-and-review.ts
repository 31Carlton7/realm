import { careful, h2, h3, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "teams-and-review",
  title: "Teams and Review",
  summary:
    "A team gives a space standing teammates: agents with a brief, a model, a clock and a budget, each one a chat you can message. Their work comes to Review, and nothing leaves Realm until you approve it.",
  body: [
    p(
      "A team is a space with teammates in it. Each teammate, a role, is an agent with a brief that says what it does and for whom, a model, a clock it wakes on and a share of the team's weekly budget. Each one is a chat you can message, as in a messenger. A role also runs on its own, and what it makes goes to **Review** for your yes before anything is posted, sent or emailed.",
    ),

    h2("Make a team"),
    steps(
      "Open the space's menu in the sidebar and choose **Make this a team…**. (The space page's **Team** tab is the same page.)",
      "Choose who's on it. Pick from the starter roles, or press **Custom teammate** to write your own.",
      "Press **Make <space> a team**. The team's page opens on its chats, and you can add, change or remove anyone later.",
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

    h2("A teammate's chat"),
    p(
      "Under the space in the sidebar, **Team** folds out to a row for each teammate, wearing its Realmite, and **Add teammate** at the foot. Click a teammate to open its chat; [[⌘]]-click opens its latest run beside you instead. The team's page lists the same chats under **Chats**.",
    ),
    p(
      "A chat is everything the teammate did, in one thread: what you said and what it answered, the drafts it sent to Review, work it handed to another teammate or took from one, the records it updated, its runs on schedule, and runs that stopped at their limit or skipped a schedule. **Show the run** under an answer opens that run's transcript in place, and while it works, **Watch it work** shows the run live.",
    ),
    h3("Message a teammate"),
    p(
      "Type in the prompter at the foot of its chat and send. What a message does depends on where the teammate is:",
    ),
    ul(
      "If its run stopped on a question, the chat shows **Asks you**, and your next message is its answer.",
      "Otherwise a message starts a run with your words and its brief, carrying on its last conversation.",
      "While it's working, your message goes when that run ends.",
    ),
    p(
      "A draft waiting for you shows in the chat with **Approve**, **Send back** and **Open in Review**. **Send back** puts the draft over the prompter, which asks **What should change?**, and what you send is the changes for that draft.",
    ),
    p(
      "The **⋯** at the head of a chat has **Run now**, which starts a run on its brief with nothing said, then **Edit…**, **Duplicate…** and **Remove <name> from the team…**. A teammate also wakes on its clock, when you answer one of its reviews, on a handoff from another teammate, or on a goal you give it. Mention it with `@` in any session in the space and it answers as that session's sub-agent, never in a looser mode than the session.",
    ),

    h2("A teammate's details"),
    p(
      "The details button at the head of a chat (**Details**) opens a drawer beside it: the teammate's **Instructions** (its brief, saved as you type), its **Goal**, when it **Wakes**, its **Budget**, its **Tools and permissions**, and the **Records it keeps**. **Edit…** opens its sheet:",
    ),
    ul(
      "**Name** and **Realmite**, the small creature that marks it. Shuffle one, or make it part by part. Its face shows the role's state (idle, working, needs you, asleep), never a mood.",
      "**What they do**: the brief. Say what it does, for whom, and what it must never do.",
      "**Model**: the newest Claude Sonnet, Opus or Haiku, or a specific Claude model. A new teammate starts on Sonnet.",
      "**Wakes**: a clock, such as every weekday at 9:00 AM, or **Only when you run it**.",
      "**A week, at most ($)**: its share of the team's weekly budget. A role whose week is spent pauses until the next.",
      "**Skills**: the skills it may use.",
    ),
    p(
      "Roles always run in Full access, because nobody is there to answer a card when one wakes. The team's policies still ask and refuse for them, as below.",
    ),

    h2("Review"),
    p(
      "What a teammate makes for your approval lands in the space's **Review**. While something waits, a **Review** row appears under the space in the sidebar, and it's counted under **Needs you**. The team's page has a **Review** row too.",
    ),
    p(
      "Review is an inbox beside the draft you're reading. The inbox says what each draft is and where it's going, in plain words, such as \"Email to dana@acme.com\", under **Waiting for you**, **In progress** and **Recent** (the last seven days).",
    ),
    p(
      "Opening one shows the draft as the thing itself: a post with its slides, an email with its subject, a document as a page, a diff, a stack of files. Above it, **Why <name> made it** is the teammate's own note. Beside it are what Realm checked before it can go, and **How it was made**, with **Open the run**. A batch steps through its items, and a new version can show the one before it.",
    ),
    p(
      "The bar at the foot says what **Approve** will do before you press it, for example that approving sends nothing and the email then waits for you to press Send. Its answers:",
    ),
    table(
      ["Action", "What happens"],
      ["**Approve**", "Accepts it (**Approve all** for a batch). Anything to post, send or email is now ready, and each item still waits for its own press."],
      ["**Send back…**", "Asks what the teammate should change, and sends your words to it. If it wakes on reviews, it starts on a new version, which comes back here."],
      ["**Reject…**", "Says no, and nothing of it can go out. If the teammate wakes on reviews and you give a reason, it's told why."],
      ["**Close**", "Puts it away without sending any of it, and without telling the teammate. It also works after you've approved, and takes back anything not sent yet."],
    ),
    p(
      "Send back, Reject and Close open in the bar itself, so the draft stays in view while you answer.",
    ),
    p(
      "After you approve something meant for outside Realm, it gets its own **Post…**, **Send…** or **Send DM…** button, which opens a sheet showing exactly what will go, from which account and when. Where Realm doesn't post or send a draft itself, the bar says so before you approve, and afterwards offers **Mark as sent** or **Mark as posted** once you've done it yourself. **Hold posting**, at the head of Review, stops every post, email and DM of the team until you press **Let go**.",
    ),
    h3("Undo an approval"),
    p(
      "Approving, in Review or in a teammate's chat, leaves a notice that says what you approved, with **Undo**. Undo puts the draft back in **Waiting for you**, and takes back any post or send it had lined up. It works until something of it has left Realm; after that, **Close** is what stops the rest.",
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
      "The team's page lists its chats, then **Review**, **Overview**, **Records** (what the team keeps, such as one record per creator), **Policies**, **Vault** and **Activity**, which lists everything the team did, newest first.",
    ),
  ],
})

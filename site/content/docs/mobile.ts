import { h2, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "mobile",
  title: "Mobile",
  summary:
    "Realm runs on your Mac. This is how it reaches your phone today, how to leave agents working while you're away, and how to build mobile apps with it.",
  body: [
    note(
      "There's no Realm app for iPhone in Realm 2.3. Answering Needs you and Review from your phone is planned to come with Realm's mobile app; until then, your phone is where Realm tells you something needs you.",
    ),

    h2("Get told on your phone"),
    p(
      "**Settings ▸ Notifications** can send the moments you'd have to come back for to your phone, as a text or a Slack message:",
    ),
    table(
      ["Setting", "What it sends"],
      ["**Text me when an agent needs me**", "An iMessage when a session is waiting on a permission, finishes, or fails. It's sent through Messages on this Mac, using the `mac` command-line tool, to the phone number or Apple ID you type, exactly as Messages knows it."],
      ["**Post to Slack**", "The same moments, posted as one line to a Slack incoming-webhook URL you paste in"],
    ),
    ul(
      "Only waiting permissions, finished or failed sessions, and unattended runs that stopped to ask for a person are sent, and each one once.",
      "They're only sent when Realm isn't the app you're in.",
      "**Notify me about** on the same page decides which kinds of moment count at all.",
    ),

    h2("Leave agents working while you're away"),
    steps(
      "Close the window, or press [[⌘Q]]. Realm stays in the menu bar and your sessions keep running.",
      "Turn on **Settings ▸ General ▸ Keep the Mac awake while agents work**. The Mac stays awake only while a session is actually running (the display still sleeps), and a session waiting on your answer doesn't count.",
      "Set up a text or a Slack post, above, so you know when one needs you.",
    ),
    p(
      "For a Mac that stays on to run a team's work, **Settings ▸ Lab** has the rest: updates that wait for running work, and a checklist of what an unattended Mac needs. See [Simulators and devices](/docs/simulators#a-mac-left-running-as-a-lab).",
    ),

    h2("Build mobile apps"),
    ul(
      "Run your iOS app in a simulator, an Android emulator or a real iPhone in the side panel, and let your agent tap through it. See [Simulators and devices](/docs/simulators).",
      "Check a web page at a phone's width with the browser's **More ▸ Device size ▸ iPhone · 390px**. See [The browser](/docs/browser).",
    ),
  ],
})

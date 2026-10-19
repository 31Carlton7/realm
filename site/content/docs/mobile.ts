import { h2, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "mobile",
  title: "Mobile",
  summary:
    "Realm runs on your Mac. This is how to pair an iPhone with it, how it reaches your phone, how to leave agents working while you're away, and how to build mobile apps with it.",
  body: [
    note(
      "Realm for iPhone is in TestFlight for now, and needs iOS 26. It reaches your Mac through Realm's relay, so it works away from home, and only while Realm is open on the Mac.",
    ),

    h2("Pair an iPhone"),
    steps(
      "On your Mac, open **Settings ▸ Devices** and press **Pair an iPhone**. A code appears, good for five minutes.",
      "Open Realm on your iPhone and scan the code.",
      "Your Mac asks **Pair <name>?**, saying it can read every session on this Mac and answer for you. Press **Pair**.",
    ),
    p(
      "A paired iPhone shows what your Mac's sessions are doing, with **Needs you** at the top by the same rule as the sidebar, and each space's sessions under it. In a session you can read the transcript, send the next message, stop a turn, answer what it's waiting on, and look at the changes it made.",
    ),
    ul(
      "What passes between the phone and the Mac is encrypted end to end, so the relay carries nothing it can read. With no iPhone paired and none being paired, the Mac doesn't connect to the relay at all.",
      "While the Mac sleeps, the phone can't reach it. **Settings ▸ General ▸ Keep the Mac awake while agents work**, below, keeps it up.",
      "**Settings ▸ Devices** lists each paired iPhone and when it was last seen. **Remove** unpairs one. On the phone, its Settings can forget the Mac.",
      "If Realm's agent server restarts, a paired iPhone finds the Mac again on its own.",
    ),

    h2("Get told on your phone"),
    p(
      "**Settings ▸ Notifications** can send the moments you'd have to come back for to your phone:",
    ),
    table(
      ["Setting", "What it sends"],
      ["**Notify my iPhone**", "A notification in Realm on your paired iPhone. It's held while you're at this Mac, and sent if the moment is still waiting two minutes later. The row appears once an iPhone is paired, and starts on."],
      ["**Text me when an agent needs me**", "An iMessage when a session is waiting on a permission, finishes, or fails. It's sent through Messages on this Mac, using the `mac` command-line tool, to the phone number or Apple ID you type, exactly as Messages knows it."],
      ["**Post to Slack**", "The same moments, posted as one line to a Slack incoming-webhook URL you paste in"],
    ),
    ul(
      "Only waiting permissions, finished or failed sessions, and unattended runs that stopped to ask for a person are sent, and each one once.",
      "Texts and Slack posts go only when Realm isn't the app you're in.",
      "**Notify me about** on the same page decides which kinds of moment count at all.",
    ),

    h2("Leave agents working while you're away"),
    steps(
      "Close the window, or press [[⌘Q]]. Realm stays in the menu bar and your sessions keep running.",
      "Turn on **Settings ▸ General ▸ Keep the Mac awake while agents work**. The Mac stays awake only while a session is actually running (the display still sleeps). A session waiting on your answer counts only while an iPhone is paired, because you might answer from the phone.",
      "Pair an iPhone, or set up a text or a Slack post, above, so you know when one needs you.",
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

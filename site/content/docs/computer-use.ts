import { careful, h2, h3, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "computer-use",
  title: "Computer use and Laya",
  summary:
    "Let an agent use the other apps on your Mac, one app and one space at a time, and run Laya, a small local model that watches each step it takes.",
  body: [
    h2("Computer use"),
    p(
      "With computer use, an agent can work in the other apps on your Mac: it reads what's on an app's screen, its controls and any form, and clicks, types and scrolls. It's off until you switch it on, and every action against an app asks you first.",
    ),
    h3("Turn it on"),
    steps(
      "Open **Settings ▸ Computer use**. Under **Computer control**, give Realm the two macOS grants it needs, Accessibility and Screen Recording. **Grant** asks macOS and opens the right pane of System Settings, and the row turns **Granted** when you switch Realm on there.",
      "Under **Spaces**, switch on **Let agents in <space> control this Mac** for the spaces that should have it.",
    ),
    p(
      "If a row says a grant isn't being honoured, which can happen after an update, **Repair** asks for it again.",
    ),
    h3("Using it"),
    ul(
      "Mention an app with `@` in a message (type `@` and the app's name) to give that session computer use for that app alone. Nothing outlives the session.",
      "The first action against an app asks you. **Always allow in this space** adds the app to the space's list in **Settings ▸ Computer use**, where **Remove** takes it off again, at once.",
      "Your session's mode still applies: in Ask each time, actions ask.",
    ),
    careful(
      "Realm itself, System Settings, password prompts, Keychain Access and terminals can never be driven, whatever you allow.",
    ),

    h2("Apps Realm reads directly"),
    p(
      "Some of your Mac's own apps are reached without driving their windows. **Settings ▸ Permissions ▸ Apps on this Mac** lists the macOS grants for Calendar, Reminders, Contacts, Mail, Messages and Notes, and **Realm's own access** lists Realm's access to your files and folders. Mention `@mac` in a message to point an agent at them.",
    ),

    h2("Another machine"),
    p(
      "The side panel's **+ ▸ Machine** (or **Connect a machine** in the palette) shows another computer's screen as a tab, which you and your agents can use:",
    ),
    table(
      ["Choice", "What it connects to"],
      ["**Another Mac**", "A Mac on your network, over Screen Sharing"],
      ["**Host and port**", "A VNC server you can already reach"],
      ["**A Linux VM here**", "A Debian, Ubuntu or Alpine VM, downloaded and run on this Mac (needs QEMU)"],
      ["**A sandbox URL**", "A sandbox desktop from Vercel, Modal, Namespace, or any VM that prints a URL"],
      ["**E2B Desktop**", "A sandbox desktop, by its sandbox ID"],
      ["**An app on this Mac**", "One app's window, shared from here (needs computer use)"],
    ),
    p("**Grab keyboard** sends your keys to the machine, including Realm's own shortcuts, until you release it. **Paste into this machine** sends your clipboard."),

    h2("Laya"),
    p(
      "Laya is Convai's open-weight decision model, which Realm runs on your Mac beside every computer and device step. It's on by default on Apple silicon, in **Shadow**, and nothing it says reaches the agent there.",
    ),
    table(
      ["Ask Laya about each step", "What happens"],
      ["**Off**", "Laya isn't asked, and won't install itself"],
      ["**Shadow**", "Laya is asked on every step and its answer is logged beside what the agent actually did. Nothing it says reaches the agent, a permission card or the transcript."],
      ["**Assist**", "Shadow, and an agent may also name an element in words, with Laya's pick used when it's sure. Never for a purchase, a deletion, a message or a password."],
    ),
    p(
      "Assist unlocks only when the active checkpoint picks the right element at least 95% of the time on held-out steps. Settings says why when it's locked.",
    ),
    h3("Installing"),
    ul(
      "Laya installs itself a few minutes after Realm opens, once your agents are idle and the disk has at least 10 GB free. The install is about 3 GB (PyTorch and the model) and needs a Python on your Mac; Realm looks for one and never guesses.",
      "The rail shows the install while it runs. **Settings ▸ Engines ▸ Laya (local decisions)** shows where it stands, with **Install** or **Try again** when it needs one.",
      "Choosing **Off** stops an install that started on its own, and Laya stays off.",
    ),
    h3("Recordings and training"),
    p(
      "Laya can learn from how you use an app. Open an app on a device in a [simulator pane](/docs/simulators), choose **Record my use of this app…** under it, and use the app yourself. The sheet says what is kept and what is left out before anything starts, and only **Start recording** starts it. Realm reads each new screen of that app and taps nothing. While it runs, **Stop** is under the device and at the foot of the rail.",
    ),
    p(
      "Laya's settings list the recordings and the decision log, each with a delete button, and **Train** makes a new checkpoint from them and what Realm ships. Everything stays in Realm's folder on your Mac.",
    ),
    note("Laya and computer use are Mac features. On Linux and Windows their settings aren't shown."),
  ],
})

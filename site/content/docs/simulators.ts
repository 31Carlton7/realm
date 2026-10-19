import { careful, h2, h3, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

export default page({
  slug: "simulators",
  title: "Simulators and devices",
  summary:
    "Open an iOS simulator, an Android emulator or a real iPhone in the side panel, use it with the mouse, and let your agent tap through your app and read its screen.",
  body: [
    h2("Open a device"),
    steps(
      "In the side panel, choose **+ ▸ Simulator**, or **Open a simulator** in the palette.",
      "Under **Which simulator?**, pick a device: the iOS simulators installed with Xcode, Android emulators, and real devices plugged into this Mac.",
      "Realm boots the simulator if it isn't running, streams its screen into the pane, and leaves it booted when the pane closes, so a cold start only happens once.",
    ),
    p(
      "Click and drag on the screen to tap and swipe, and type to type. The device keeps its controls in a toolbar centred over it:",
    ),
    table(
      ["Control", "What it does"],
      ["**Home**", "Press the home button"],
      ["**Rotate**", "Rotate the device"],
      ["**Screenshot**", "Save a screenshot of the device into the space's `simulator/` folder"],
      ["**Elements**", "Show the device's elements: the accessibility tree behind the screen"],
      ["**More device controls**", "Volume, the side button, the device's apps, the device frame, and **Device settings…**: light or dark appearance, text size, Reduce Motion, Reduce Transparency, Increase Contrast, colour filters, slow animations and the debug overlays"],
    ),
    note("Simulators need Xcode for iOS, and the Android SDK's `adb` for Android. They're a Mac feature, so on Linux and Windows the menu doesn't offer them."),

    h2("A real iPhone"),
    p(
      "An iPhone or iPad on a cable shows up under **Connected devices**. Realm reaches it through Xcode with a small test runner it installs on the phone while the pane is open, and the pane says what's missing when something is:",
    ),
    ul(
      "Developer Mode on the phone (**Settings ▸ Privacy & Security ▸ Developer Mode**)",
      "UI automation allowed (**Settings ▸ Developer ▸ Enable UI Automation**)",
      "Your developer certificate trusted (**Settings ▸ General ▸ VPN & Device Management**)",
      "An Apple Development identity on this Mac, from **Xcode ▸ Settings ▸ Accounts**. Running any app on the phone from Xcode once registers it with your team.",
      "The phone unlocked, and an Xcode at least as new as the phone's iOS.",
    ),

    h2("What your agent can do"),
    p(
      "With Realm's simulator tools an agent can list the devices, open one in a pane, install and launch an app, open a URL, read the screen's elements and take screenshots, and tap, double-tap, long-press, swipe, type and press the device's buttons. It reads elements by their labels, so it taps \"Sign in\" rather than a coordinate.",
    ),
    ul(
      "Reading a device (its elements, its apps, a screenshot) never asks.",
      "Opening, installing and launching follow the session's [permission mode](/docs/permissions).",
      "Tapping, typing and swiping ask once per device per session, and either Allow covers the rest of that session. Full access skips the card for a simulator or an emulator.",
      "A physical iPhone, iPad or Android phone asks even in Full access. In Plan and Ask, an agent can only read a device.",
      "When an agent walks a path of several taps in one go, it stops rather than guess, and never takes a step that buys, deletes, sends, signs out or enters a password.",
    ),
    careful("A real phone holds your accounts. Give an agent one to drive only when you're ready to answer its requests."),

    h3("Record for Laya"),
    p(
      "Under a device's screen, **Record my use of this app…** records you using the app, for [Laya](/docs/computer-use#laya) to learn from. It shows what is kept before anything starts.",
    ),

    h2("A Mac left running as a lab"),
    p(
      "**Settings ▸ Lab** is for a Mac that stays on to run a team's work, such as a Mac mini with phones plugged in. **This Mac is a lab** makes updates wait for the **Update window** you set and for team runs to finish, then install on their own. **Ready to be left alone** checks the settings an unattended Mac needs, and **Devices** lists the phones and simulators the lab can use. **From your laptop** says how to reach the lab Mac over Screen Sharing.",
    ),
  ],
})

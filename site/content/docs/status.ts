import { h2, p, page, table, ul } from "@/lib/docs-blocks"

// Checked on 23 October 2026 against the v2.4.0 tree, main, CHANGELOG.md, docs/platforms.md, the release list on
// GitHub and the troubleshooting page; the repository had no issues filed, open or closed, that day. Brought up to
// date on 24 October with what Realm 2.5 brings: #219, #221, #222, feat/remote-runtime and
// chore/build-without-private-registry, and the Linux bench run 40073363274.
// TODO(owner): re-read this page at each release, and move the date in the summary when you do.
export default page({
  slug: "status",
  title: "Status and known limitations",
  summary:
    "What's finished, what's still a preview or in beta, what Realm doesn't do yet, and the problems known today. Last updated 24 October 2026, for Realm 2.4.0 and what 2.5 brings.",
  body: [
    p(
      "Realm is in active development and ships often: eighteen releases between 4 September and 19 October 2026, the latest Realm 2.4.0. This page is kept by hand, and its date is at the top.",
    ),

    h2("Where it runs"),
    table(
      ["Where", "Status"],
      ["Mac with Apple silicon", "Supported, with every feature. Releases are signed and notarized by Apple, and update themselves."],
      ["Mac with an Intel processor", "Not supported. The Mac build is made for Apple silicon only."],
      ["Linux on x64", "A preview, as an AppImage and a .deb. Unsigned, doesn't update itself, and hides the features that need a Mac."],
      ["Windows on x64", "A preview, as an installer. Unsigned, so SmartScreen warns the first time it runs; doesn't update itself, and hides the features that need a Mac."],
      ["iPhone", "In beta, in TestFlight, and needs iOS 26 and a Mac running Realm. The app and the relay it reaches your Mac through aren't open to the public yet."],
      ["Android, the web", "No app."],
    ),
    p(
      "Realm's CI builds, tests and packages the previews on Linux and on Windows for every pull request. The tests that must pass there are the ones written for those systems' own code paths; the rest of the suite runs there for information, because it was written on a Mac. Builds of 2.5 have run on GitHub's x86_64 Ubuntu 24.04 runners: the AppImage opens its first window in about 3.3 seconds, its server runs worktree tasks headless (see [Benchmarks](/docs/benchmarks)), and the .deb installs with apt. The packaged [command line](/docs/command-line) has run a worktree command on GitHub's macOS and Windows runners too, but Realm's window on Windows hasn't been measured yet. [Troubleshooting](/docs/troubleshooting#linux-and-windows) covers installing the previews.",
    ),

    h2("New since 2.4.0"),
    p("On main now:"),
    ul(
      "**The MIT License.** Realm's source has been MIT-licensed since 23 October 2026 (#221). The repository had no license before that, including at Realm 2.4.0. A few bundled parts, such as the fonts, keep their own licenses.",
    ),
    p("Coming in Realm 2.5:"),
    ul(
      "**The command line.** `realm` runs the agent server without a window and drives it from scripts, and every packaged app carries it. See [Command line](/docs/command-line).",
      "**Realm on a server.** `realm serve` takes clients on other machines, behind access tokens and TLS or Tailscale Serve, and `realm service install` keeps it running. See [Run Realm on a server](/docs/run-on-a-server).",
      "**Pairing a phone from a terminal.** `realm pair` draws the pairing code in the terminal, so a server with no window can pair an iPhone, and `realm phones` lists and removes them.",
      "**Building without the Pro icons.** A source checkout builds with `pnpm install` alone: without a Hugeicons Pro token it draws Hugeicons' free pack, which has the same glyphs.",
      "**A lighter Linux AppImage.** It runs on AppImage's static runtime, so Ubuntu 22.04 and later don't need libfuse2, and it's 250 MB where it was 399.",
    ),

    h2("What Realm doesn't do"),
    ul(
      "**Run agents in a cloud of its own.** There's no hosted runner or plan. Agents run where Realm runs: your computer, a Mac you leave on (see [A Mac left running as a lab](/docs/simulators#a-mac-left-running-as-a-lab)), or, from 2.5, a server of yours (see [Run Realm on a server](/docs/run-on-a-server)).",
      "**Run in a browser.** The app on your computer and the iPhone app are the only ways in.",
      "**Wall agents off from each other by itself.** A worktree keeps their files apart, but each agent runs as you, with your network and your files, unless the space has a [sandbox](/docs/permissions#the-sandbox), and the sandbox is on a Mac only.",
      "**Run Codex in a sandboxed space.** Every Codex session shares one process, and a process can hold only one sandbox policy, so a space with a sandbox refuses to start one. Set the space's **Sandbox** to **No sandbox**, or use another agent there.",
      "**Send a team's posts, emails or DMs itself.** Review says so before you approve one, and once you've sent it yourself, **Mark as sent** or **Mark as posted** records it. See [Teams and Review](/docs/teams-and-review).",
    ),

    h2("Known issues"),
    ul(
      "On Linux and Windows, a few things still assume a Mac. ⌘-click to open a session beside the one you're in, and [[⌘⌫]] to deny a permission card, use the Super or Windows key there instead of Ctrl, and some tooltips still show ⌘. Realm looks for editors only where macOS keeps applications, so it doesn't offer to open a file in your editor there.",
      "On Linux and Windows, Realm doesn't update itself: install each new version from the [releases page](https://github.com/31Carlton7/realm/releases).",
      "If Realm's agent server restarts, each terminal comes back as a new shell in the same folder, with its last screen only if **Keep terminal scrollback** is on. A command that was running in it isn't run again.",
    ),

    h2("How releases ship"),
    ul(
      "Releases are cut by hand and published on [GitHub](https://github.com/31Carlton7/realm/releases). A Mac release is a disk image and a zip for the updater, signed with a Developer ID and notarized by Apple. The Linux and Windows builds come from CI runs on each system and aren't signed.",
      "A release starts its packaged agent server once, to check it runs, before it's published.",
      "On a Mac, Realm checks for a new version when it opens and every four hours while it runs, downloads it in the background, and asks before restarting into it. Your agents keep working through the restart.",
      "Every release is in the [changelog](/changelog), and the first window after an update shows that version's notes. When an update can't be undone, the changelog says so: 2.1.0's storage change was one, since an older Realm can't read history it wrote.",
    ),
    p("Found something that isn't here? Open an issue on [GitHub](https://github.com/31Carlton7/realm/issues)."),
  ],
})

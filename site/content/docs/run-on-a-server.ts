import { h2, note, p, page } from "@/lib/docs-blocks"

// TODO(owner): a placeholder for the remote runtime, the background service and `realm pair`, which another
// builder is making. It is built at /docs/run-on-a-server but listed nowhere (`unlisted` in
// content/docs/index.ts) and asks search engines not to index it. Fill in every TODO below, replace the
// summary, then move the page into the "Extend Realm" group after Command line.
export default page({
  slug: "run-on-a-server",
  title: "Run Realm on a server",
  summary:
    "TODO: one or two sentences on running Realm's agent server on another machine, keeping it running as a service, and pairing a phone with it.",
  body: [
    note("TODO: say which release this comes with. Until it ships, this page stays out of the docs' navigation."),
    p(
      "TODO: what running Realm on a server is for, in a sentence or two: agents that keep working while your computer sleeps, on a machine you choose, reached from Realm on your computer and from your phone.",
    ),

    h2("What you need"),
    note("TODO: the systems it runs on, whether it needs the app or only Node.js (and which version), the ports it opens, and the accounts each agent needs on the server."),

    h2("Remote runtime"),
    note("TODO: what the remote runtime is, how to start it on the server, and how Realm on your computer connects to it: what you type, what it shows once it's connected, and what runs where."),

    h2("Run it as a background service"),
    note("TODO: keeping the server running as a service (systemd on Linux, launchd on a Mac): the command that installs it, where it logs, how to update it, and how to stop and remove it."),

    h2("Pair a phone with realm pair"),
    note("TODO: the `realm pair` command, what it prints, how the iPhone app scans or enters it, and how to unpair a phone."),

    h2("Security"),
    note("TODO: who can reach the server and how it's authenticated, what crosses the network and whether it's encrypted, and where its data and sign-ins are kept."),

    h2("Limits"),
    note("TODO: what doesn't work on a server yet, such as the Mac-only features, and anything still in preview."),
  ],
})

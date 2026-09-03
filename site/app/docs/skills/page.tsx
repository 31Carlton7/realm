import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "Skills",
  description: "Skills are folders on disk, laid out exactly like the library they install into.",
}

export default function SkillsPage() {
  return (
    <DocPage
      title="Skills"
      lede="A skill is a folder. Installing one is a copy, and auditing one is reading it."
      next={{ href: "/docs/packaging", label: "Packaging & updates" }}
    >
      <h2>Layout</h2>
      <p>
        Skills Realm ships live in <code>skills/</code>, one folder per skill, laid out exactly like the
        library at <code>~/Realm/skills/</code>. The two directories have the same shape on purpose:
        there is no build step, no manifest to regenerate, and no format conversion between the version
        in the repository and the version on your disk.
      </p>

      <h2>Enabling one today</h2>
      <p>
        <code>SkillSync</code> — per-profile enablement plus the symlink into each session's{" "}
        <code>.claude/skills/</code> — is not built yet. Until it is, enable a bundled skill by hand:
      </p>
      <pre>
        <code>ln -s &quot;$PWD/skills/mac&quot; ~/.claude/skills/mac</code>
      </pre>

      <h2>What ships</h2>
      <h3>mac</h3>
      <p>
        Wraps the <a href="https://macoscli.sh">mac-cli</a> binary: Calendar, Reminders, Contacts, Mail,
        Messages, Notes, Music, TV, Shortcuts, Finder and iWork from the shell.
      </p>
      <p>
        Realm spawns agents and terminals with its own environment, so <code>mac</code> is already on a
        session's <code>PATH</code> whenever it is on the <code>PATH</code> Realm was launched from. The
        skill exists to make it <strong>discoverable</strong>, not reachable — an agent that does not
        know a tool exists will not reach for it.
      </p>
    </DocPage>
  )
}

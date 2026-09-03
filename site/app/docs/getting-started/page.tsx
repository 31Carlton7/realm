import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "Getting started",
  description: "Install dependencies, build the server, and run Realm locally.",
}

export default function GettingStartedPage() {
  return (
    <DocPage
      title="Getting started"
      lede="Realm runs from the repository today. Four commands and you have the app in front of you."
      next={{ href: "/docs/spaces-and-panes", label: "Spaces & panes" }}
    >
      <h2>1. Install</h2>
      <pre>
        <code>pnpm install</code>
      </pre>
      <p>
        The Hugeicons Pro registry token has to be reachable — either in a repository{" "}
        <code>.npmrc</code> copied from <code>.npmrc.example</code>, or in your <code>~/.npmrc</code>.
      </p>

      <h2>2. Build the server</h2>
      <pre>
        <code>pnpm --filter @realm/server build</code>
      </pre>
      <p>
        Desktop dev spawns <code>apps/server/dist/main.js</code> with the system <code>node</code>. Set{" "}
        <code>REALM_NODE</code> to pin a specific binary, or <code>REALM_SERVER_ENTRY</code> to point at
        another build. The root <code>pnpm dev</code> runs this build for you, so this step is only
        worth knowing about when something goes wrong.
      </p>

      <h2>3. Run it</h2>
      <pre>
        <code>pnpm dev</code>
      </pre>

      <h2>4. Start a session</h2>
      <p>
        Claude sessions drive the <code>claude</code> CLI, so it needs to be installed and logged in:
      </p>
      <pre>
        <code>claude auth login</code>
      </pre>
      <p>
        The adapter probes for it in <strong>New → Session…</strong> and tells you when it is missing or
        the login has expired — an expired login shows up as an error in the transcript rather than a
        silent hang.
      </p>
      <p>To work on the UI without a Claude login at all:</p>
      <pre>
        <code>REALM_ENABLE_FAKE_AGENT=1 pnpm dev</code>
      </pre>
      <p>
        That registers a scripted <strong>Fake agent</strong> next to Claude. It echoes what you send,
        which is enough to exercise the whole transcript, permission and interrupt path offline.
      </p>

      <h2>Everyday commands</h2>
      <table>
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>pnpm dev</code>
            </td>
            <td>Build the server, then run server and desktop together.</td>
          </tr>
          <tr>
            <td>
              <code>pnpm test</code>
            </td>
            <td>The full Vitest suite.</td>
          </tr>
          <tr>
            <td>
              <code>pnpm typecheck</code>
            </td>
            <td>Types across every workspace package.</td>
          </tr>
          <tr>
            <td>
              <code>pnpm dist</code>
            </td>
            <td>
              A full build plus a DMG and zip in <code>apps/desktop/release/</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Pointing it somewhere safe</h2>
      <p>
        Realm reads and writes <code>~/Realm/</code> by default. When you are testing something that
        touches the database, give it a scratch home instead so your real sessions are never in the
        blast radius:
      </p>
      <pre>
        <code>REALM_HOME=$(mktemp -d) pnpm dev</code>
      </pre>
    </DocPage>
  )
}

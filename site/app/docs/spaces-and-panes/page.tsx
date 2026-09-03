import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "Spaces & panes",
  description: "How Realm organises work: profiles hold spaces, spaces hold panes.",
}

export default function SpacesAndPanesPage() {
  return (
    <DocPage
      title="Spaces & panes"
      lede="Two ideas carry the whole interface. A space is a piece of work. A pane is a thing you are looking at while you do it."
      next={{ href: "/docs/sessions", label: "Agent sessions" }}
    >
      <h2>Spaces</h2>
      <p>
        A <strong>profile</strong> holds spaces; a space holds one piece of work. Everything scoped to
        that work belongs to the space rather than to the window:
      </p>
      <ul>
        <li>the pane layout, restored exactly as you left it</li>
        <li>the context pool the space's sessions draw on</li>
        <li>the MCP servers its sessions are allowed to reach</li>
        <li>a colour, which is the one piece of per-space theming the app applies at runtime</li>
      </ul>
      <p>
        Switching work means switching space. You are not rebuilding a window each time, and two spaces
        never share state by accident.
      </p>

      <h2>Panes</h2>
      <p>Every kind of pane is the same kind of object. Today that includes:</p>
      <ul>
        <li>
          <strong>Sessions</strong> — a running agent and its transcript
        </li>
        <li>
          <strong>Terminals</strong> — a login shell, spawned with Realm's own environment
        </li>
        <li>
          <strong>Browser</strong> — a page an agent can drive and you can watch
        </li>
        <li>
          <strong>Simulator</strong> — for work that targets a device
        </li>
        <li>
          <strong>Artifacts</strong> — diffs, files and output a session produced
        </li>
      </ul>
      <p>
        Because they share one pane system, splitting a terminal beside a session is the same operation
        as splitting two sessions. There is no pane type with its own special layout rules.
      </p>

      <h2>Layout is a contract</h2>
      <p>
        Pane arrangement is not component state. Splits, resizes, moves and closes are typed operations
        defined in <code>packages/contracts</code> and applied to a layout tree that both the renderer
        and the server understand.
      </p>
      <p>
        The practical consequence: a layout can be persisted, restored, and reasoned about in tests
        without a running window. It is also why layout changes survive a relaunch without a
        serialisation step written specially for them.
      </p>

      <h2>Terminals and PATH</h2>
      <p>
        Terminals spawn login shells (<code>-l</code>), and sessions inherit Realm's environment. When
        Realm is launched from a terminal that inherits your usual <code>PATH</code>, agent CLIs and
        tools like <code>mac</code> resolve inside panes without any extra configuration.
      </p>
      <blockquote>
        <p>
          Launched from Finder, an app inherits launchd's minimal <code>PATH</code>, which has neither{" "}
          <code>claude</code> nor <code>node</code> on it. The packaged app handles this by adopting the
          login shell's <code>PATH</code> at startup, before anything spawns.
        </p>
      </blockquote>
    </DocPage>
  )
}

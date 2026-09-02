import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "Agent sessions",
  description: "How Realm runs agents, and why transcripts survive a relaunch.",
}

export default function SessionsPage() {
  return (
    <DocPage
      title="Agent sessions"
      lede="A session is an agent, its transcript, and the events that produced it. Realm stores the events and derives the rest."
      next={{ href: "/docs/mcp-gateway", label: "MCP gateway" }}
    >
      <h2>Adapters</h2>
      <p>
        Agents reach Realm through adapters in <code>packages/adapters</code>. Two ship today:
      </p>
      <ul>
        <li>
          <strong>Claude</strong> — runs on <code>@anthropic-ai/claude-agent-sdk</code>, which drives the{" "}
          <code>claude</code> CLI. Install it and log in first with <code>claude auth login</code>.
        </li>
        <li>
          <strong>Fake</strong> — a scripted agent that echoes what you send. Enable it with{" "}
          <code>REALM_ENABLE_FAKE_AGENT=1</code> for offline and UI work.
        </li>
      </ul>
      <p>
        Every adapter emits the same session events, so the transcript, the permission prompts and the
        interrupt path are written once and work for all of them. Adding an agent does not mean adding
        a second way for the app to display a conversation.
      </p>

      <h2>Events are the truth</h2>
      <p>
        Sessions live in two tables in <code>~/Realm/realm.db</code>: <code>sessions</code>, and{" "}
        <code>session_events</code>. The event table is append-only. What you see in a pane is rebuilt
        from it every time the app starts.
      </p>
      <p>This is what makes the following true:</p>
      <ul>
        <li>Quitting mid-run loses nothing — the events already landed.</li>
        <li>
          A later message <strong>resumes</strong> the provider session instead of starting a fresh one.
        </li>
        <li>
          A transcript can be replayed and asserted against in tests without a live agent on the other
          end.
        </li>
      </ul>

      <h2>Permissions and interrupts</h2>
      <p>
        Tool calls that need your approval surface as permission cards in the transcript, and an
        in-flight run can be interrupted from the pane. Both paths are adapter-agnostic, which is why
        the Fake agent is enough to exercise them.
      </p>

      <h2>Troubleshooting</h2>
      <table>
        <thead>
          <tr>
            <th>Symptom</th>
            <th>Cause</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>New → Session… reports the agent is unavailable</td>
            <td>
              The <code>claude</code> CLI is not installed, or not on the <code>PATH</code> Realm was
              launched from.
            </td>
          </tr>
          <tr>
            <td>An error appears in the transcript on first message</td>
            <td>
              The CLI is present but the login has expired. Re-run <code>claude auth login</code>.
            </td>
          </tr>
          <tr>
            <td>Session list is empty after a reinstall</td>
            <td>
              <code>REALM_HOME</code> is pointing somewhere other than <code>~/Realm</code>.
            </td>
          </tr>
        </tbody>
      </table>
    </DocPage>
  )
}

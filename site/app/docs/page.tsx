import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "Overview",
  description: "What Realm is, what it is made of, and where its data lives.",
}

export default function OverviewPage() {
  return (
    <DocPage
      title="Overview"
      lede="Realm is a local-first control plane for coding agents on macOS. It runs on your machine, keeps its data on your disk, and gives every agent a place to work."
      next={{ href: "/docs/getting-started", label: "Getting started" }}
    >
      <h2>The shape of it</h2>
      <p>
        A <strong>profile</strong> holds <strong>spaces</strong>. A space is one piece of work — a
        repository, a project, an investigation — and it owns everything that work needs: its pane
        layout, its context pool, and its MCP servers.
      </p>
      <p>
        Inside a space, everything is a <strong>pane</strong>: agent sessions, terminals, a browser, a
        simulator, artifacts. Panes split and resize through one shared layout contract, so a session
        pane and a terminal pane behave identically.
      </p>

      <h2>What it is built from</h2>
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>apps/desktop</code>
            </td>
            <td>The Electron + React app: window, panes, sidebar, composer.</td>
          </tr>
          <tr>
            <td>
              <code>apps/server</code>
            </td>
            <td>
              realm-server — owns the database and every running session. The renderer reaches it only
              over a WebSocket on <code>127.0.0.1</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>packages/contracts</code>
            </td>
            <td>Zod schemas, layout operations and session events shared by both sides.</td>
          </tr>
          <tr>
            <td>
              <code>packages/adapters</code>
            </td>
            <td>Agent adapters — Claude, and a scripted Fake agent for offline work.</td>
          </tr>
          <tr>
            <td>
              <code>packages/ui</code>
            </td>
            <td>Icons and the theme both the app and this site draw their tokens from.</td>
          </tr>
        </tbody>
      </table>

      <h2>Where your data lives</h2>
      <p>
        Everything is under <code>~/Realm/</code>, and <code>REALM_HOME</code> moves it. Sessions and
        their events are rows in <code>~/Realm/realm.db</code>, a SQLite database in WAL mode.
      </p>
      <blockquote>
        <p>
          <strong>Transcripts are derived, not stored.</strong> The <code>session_events</code> table is
          the append-only truth; the transcript you see is rebuilt from it on every relaunch. That is
          why quitting mid-run loses nothing, and why the next message can resume the provider session
          rather than starting a new one.
        </p>
      </blockquote>
      <p>
        Because the database is WAL, copy it with <code>VACUUM INTO</code> rather than <code>cp</code> —
        a bare copy leaves the write-ahead log behind and can hand you a torn snapshot.
      </p>

      <h2>Requirements</h2>
      <ul>
        <li>macOS</li>
        <li>Node 22.13 or newer, and pnpm 10</li>
        <li>
          The <code>claude</code> CLI, installed and logged in, for Claude sessions
        </li>
      </ul>
    </DocPage>
  )
}

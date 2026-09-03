import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "MCP gateway",
  description: "One endpoint per session, credentials that stop at the gateway, every call logged.",
}

export default function McpGatewayPage() {
  return (
    <DocPage
      title="MCP gateway"
      lede="Third-party MCP servers are configured per space, not per agent — so a session gets one Realm endpoint instead of your credentials."
      next={{ href: "/docs/skills", label: "Skills" }}
    >
      <h2>Why it is a gateway</h2>
      <p>
        The obvious way to give an agent an MCP server is to write the server's config — and its token —
        into the agent CLI's own configuration. That hands the credential to the agent, to every tool
        the agent runs, and to anything that can read the file.
      </p>
      <p>Realm puts a gateway in between instead:</p>
      <ul>
        <li>You configure the server once, in the space's settings.</li>
        <li>
          Every session in that space gets <strong>one</strong> Realm gateway endpoint.
        </li>
        <li>Credentials and OAuth tokens are held by the gateway and never reach the agent CLI.</li>
        <li>Every proxied tool call is recorded.</li>
      </ul>

      <h2>Configuring a server</h2>
      <p>
        Space settings → MCP. Servers belong to the space, so two spaces can reach different servers, or
        the same server with different credentials, without either one knowing about the other.
      </p>

      <h2>Watching what happened</h2>
      <p>
        Every call the gateway proxies shows up in the Activity view — space settings → Activity, or{" "}
        <strong>MCP Activity</strong> in the command palette. It is a straight log of what each session
        asked for and what came back.
      </p>
      <blockquote>
        <p>
          This is the part worth checking the first time you connect a server. If a tool call is
          happening that you did not expect, the Activity view is where it is visible — before it is
          visible in the result.
        </p>
      </blockquote>

      <h2>Realm's own tools</h2>
      <p>
        The same path carries Realm's built-in servers, so a session's browser and agent tools arrive
        through the identical mechanism as a third-party server. There is no privileged side channel.
      </p>
    </DocPage>
  )
}

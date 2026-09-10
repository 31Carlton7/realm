import { Icon } from "@realm/ui";
import { CONNECTORS, connectorServerName, type Connector, type McpServer } from "@realm/contracts";
import { useState, type FormEvent } from "react";
import { PageScroll } from "../../components/ScrollFades";
import { Sheet } from "../../components/Sheet";
import { useApp } from "../../state/store";
import { McpSection } from "../../components/sidebar/McpSection";
import type { PaneProps } from "../registry";

/**
 * The Connections page (Plan 12 W4): the sidebar destination for MCP servers, on the W3 page pattern.
 * No rail — one section, so the head leads straight into the content column.
 *
 * The body IS McpSection, the same component the space page's Connections tab mounts — scope groups,
 * provider rows, hub status dots, Test, the add/edit form and MCP_SECRET_STORAGE_NOTE all live THERE,
 * once. This page adds only the destination chrome; anything more would be the fork W4 forbids.
 *
 * Vantage: `item.spaceId` — the space whose layout holds the pane (see LibraryPage's twin comment).
 */
export function ConnectionsPage({ item }: PaneProps) {
  const spaceId = item.spaceId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));

  if (!space) return <div className="pane-placeholder muted">This page's space no longer exists.</div>;

  return (
    <div className="page connections-page-pane">
      <header className="page-head">
        <div className="page-title"><h1>Connections</h1></div>
        <span className="page-vantage">{space.name}</span>
      </header>
      <div className="page-body">
        {/* Both ends dissolve, but only when there is something under them — and only over the
            column, which is what `PageScroll` wraps. The column pads by their depth so a row under
            one is still clickable. */}
        <PageScroll>
          <ConnectorMarket spaceId={spaceId} />
          <McpSection spaceId={spaceId} />
        </PageScroll>
      </div>
    </div>
  );
}

/** What a card says about its app, from the MCP server row the connector registered (if any). */
export function connectorState(c: Connector, servers: readonly McpServer[]): "none" | "pending" | "connected" | "reconnect" {
  const row = servers.find((s) => s.name === connectorServerName(c));
  if (!row) return "none";
  if (row.oauthStatus === "connected") return "connected";
  if (row.oauthStatus === "reconnect_needed") return "reconnect";
  return "pending";
}

/**
 * The apps a space can be connected to in one click, as cards.
 *
 * Each is a vendor's own remote MCP server with OAuth (`CONNECTORS`), so the card's one action is
 * "Connect": Realm creates the server row and opens the vendor's sign-in. From then on the row is
 * an ordinary server in the list below, with the same tools policy and activity — the cards are a
 * front door, not a second system. A card also names what the connection is FOR in the prompter:
 * a pasted link to that app becomes a chip the agent can follow.
 */
function ConnectorMarket({ spaceId }: { spaceId: string }) {
  const servers = useApp((s) => s.mcpServers);
  const connectApp = useApp((s) => s.connectApp);
  const run = useApp((s) => s.run);
  const [appFor, setAppFor] = useState<Connector | null>(null);
  const connect = (c: Connector, client?: { clientId: string; clientSecret?: string }) => run(async () => {
    const { authUrl } = await connectApp(spaceId, c.id, client);
    window.open(authUrl, "_blank");
  });
  /* A vendor that issues no client on the fly asks for the user's own app first — whenever the row
     holds no client yet, which includes a row left behind by a Connect that failed for exactly that
     reason. `authKind` reads "oauth" once a client is stored; Reconnect on such a row reuses it. */
  const press = (c: Connector, state: ReturnType<typeof connectorState>) => {
    const row = servers.find((s) => s.name === connectorServerName(c));
    const hasClient = row?.authKind === "oauth";
    if (c.oauth === "app" && !hasClient && state !== "connected") setAppFor(c); else connect(c);
  };
  return (
    <section className="market" aria-label="Connect an app">
      <div className="mcp-section-head"><span>Connect an app</span></div>
      <p className="market-lede">One click, signed in through the app itself. Paste a link from any of these into a prompt and the agent gets a chip it can follow.</p>
      <ul className="market-grid">
        {CONNECTORS.map((c) => {
          const state = connectorState(c, servers);
          return (
            <li key={c.id} className="market-card" data-state={state}>
              <span className="market-mark"><Icon name={c.icon} size={20} colored /></span>
              <span className="market-text">
                <span className="market-name">{c.name}</span>
                <span className="market-blurb">{c.blurb}</span>
              </span>
              <span className="market-foot">
                {state === "connected" && <span className="market-state" data-tone="ready"><Icon name="check" size={12} /> Connected</span>}
                {state === "reconnect" && <button type="button" className="btn" onClick={() => press(c, state)}>Reconnect</button>}
                {state === "pending" && <button type="button" className="btn" onClick={() => press(c, state)}>Finish signing in</button>}
                {state === "none" && <button type="button" className="btn primary" onClick={() => press(c, state)}>Connect</button>}
                <a className="market-docs" href={c.docs} target="_blank" rel="noreferrer" aria-label={`About the ${c.name} server`}>Docs</a>
              </span>
            </li>
          );
        })}
      </ul>
      {appFor && <AppClientSheet connector={appFor} onClose={() => setAppFor(null)}
        onSubmit={(client) => { setAppFor(null); connect(appFor, client); }} />}
    </section>
  );
}

/**
 * The one extra step a vendor like Slack imposes: an app of the user's own, whose client id and
 * secret Realm then presents. The steps name exactly what to set in the vendor's console — the
 * redirect URL above all, which is the site's HTTPS relay rather than this Mac — because that is
 * the part nobody guesses right.
 */
function AppClientSheet({ connector, onClose, onSubmit }: { connector: Connector; onClose: () => void; onSubmit: (client: { clientId: string; clientSecret?: string }) => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); if (clientId.trim()) onSubmit({ clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined }); };
  return (
    <Sheet title={`Connect ${connector.name}`} onClose={onClose} width={520}>
      <form className="form" onSubmit={submit}>
        <p className="settings-note">{connector.name} issues no client to apps it has not met. Create one in your workspace and paste what it gives you.</p>
        <ol className="market-steps">
          {connector.app?.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        {connector.app && <a className="market-docs" href={connector.app.url} target="_blank" rel="noreferrer">Open {connector.name}'s app console</a>}
        <label className="field"><span>Client ID</span>
          <input aria-label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoFocus /></label>
        <label className="field"><span>Client secret</span>
          <input aria-label="Client secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
        <p className="settings-note">Stored sealed with the rest of this server's OAuth state; the agent never receives it.</p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!clientId.trim()}>Continue to {connector.name}</button>
        </div>
      </form>
    </Sheet>
  );
}

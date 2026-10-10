import { Icon, isIconName } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { riskRank, type TeamPolicies, type TeamPolicyConnector, type TeamSpace } from "@realm/contracts";
import { useApp } from "../../state/store";
import { policiesClient } from "./policies-client";
import { ACT_ROWS, CLASS_SHORT, classRows, connectorSource, connectorSummary, todayWords, toolLabel, toolNote } from "./policies-format";

/**
 * The team's Policies page (the dynamic-Teams plan, §7), read-only: what each tool a role here could
 * call can do to the world, who said so, and what a call does today. Realm's own toolsets are one
 * connection; each server the space runs is another, listed live. Nothing on the page changes what
 * runs, so it carries no control but the disclosures.
 */
export function PoliciesPage({ spaceId, team }: { spaceId: string; team: TeamSpace }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const [data, setData] = useState<TeamPolicies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    policiesClient().view(spaceId).then((v) => { if (live) { setData(v); setError(null); } }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [spaceId, team]);

  // Realm's toolsets read as ONE connection: the person connected none of them, and fifteen rows of
  // built-ins would bury the servers they did connect.
  const connections = useMemo<TeamPolicyConnector[]>(() => {
    if (!data) return [];
    const realm = data.connectors.filter((c) => c.kind === "realm");
    const merged: TeamPolicyConnector[] = realm.length === 0 ? [] : [{
      connector: "realm", kind: "realm", name: "Realm", icon: null, reached: true,
      tools: realm.flatMap((c) => c.tools.map((t) => ({ ...t, tool: `${c.name}: ${toolLabel(t.tool, c.name)}` }))),
    }];
    return [...merged, ...data.connectors.filter((c) => c.kind === "server")];
  }, [data]);
  const rows = useMemo(() => (data ? classRows(data.connectors) : []), [data]);
  const total = connections.reduce((n, c) => n + c.tools.length, 0);
  const irreversible = connections.reduce((n, c) => n + c.tools.filter((t) => t.class === "irreversible-external").length, 0);

  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Policies</h1></div>
        <span className="page-vantage t-num">{data ? `${total} tools · ${irreversible} can't be taken back` : ""}</span>
      </header>
      <div className="form">
        <p className="tp-lede">What {space?.name ?? "this team"}'s roles can call, by what a call can do to the world, and what happens today when one does.</p>
        {error && <p className="settings-hint" role="alert">{error}</p>}
        {!data ? (!error && <p className="tp-empty">Loading…</p>) : (
          <>
            <h3 className="settings-head">By kind of action</h3>
            <ul className="settings-list">
              {rows.map((r) => (
                <li key={r.class} className="settings-row" data-class={r.class}>
                  <div className="settings-row-main">
                    <span className="settings-row-name">{r.words}</span>
                    <span className="settings-row-detail">{r.examples.length > 0 ? r.examples.join(" · ") : "Nothing a role here can call does this"}</span>
                  </div>
                  <span className="tpol-value">{r.today}</span>
                </li>
              ))}
            </ul>

            <h3 className="settings-head">Posts, DMs and email</h3>
            <ul className="settings-list">
              {ACT_ROWS.map((a) => (
                <li key={a.label} className="settings-row">
                  <div className="settings-row-main">
                    <span className="settings-row-name">{a.label}</span>
                    <span className="settings-row-detail">{a.detail}</span>
                  </div>
                  <span className="tpol-value">You approve, then press each one</span>
                </li>
              ))}
            </ul>

            <h3 className="settings-head">Connections</h3>
            <ul className="settings-list">
              {connections.flatMap((c) => {
                const expanded = open === c.connector;
                const head = (
                  <li key={c.connector} className="settings-row tp-row-link">
                    <button type="button" className="tp-row-button tv-row" aria-expanded={expanded} disabled={c.tools.length === 0}
                      onClick={() => setOpen(expanded ? null : c.connector)}>
                      <span className="tv-glyph">
                        {c.icon && isIconName(c.icon) ? <Icon name={c.icon} size={16} colored /> : <Icon name={c.kind === "realm" ? "tool" : "serverStack"} size={16} />}
                      </span>
                      <span className="tv-text">
                        <span className="tv-name">{c.name}</span>
                        <span className="tv-detail">{connectorSource(c)}</span>
                      </span>
                      <span className="tpol-value t-num">{connectorSummary(c)}</span>
                      {c.tools.length > 0 && <Icon name={expanded ? "chevronUp" : "chevronDown"} size={16} className="tpol-chevron" />}
                    </button>
                  </li>
                );
                if (!expanded) return [head];
                const tools = [...c.tools].sort((a, b) => riskRank(b.class) - riskRank(a.class) || a.tool.localeCompare(b.tool));
                return [head, ...tools.map((t) => (
                  <li key={`${c.connector}#${t.tool}`} className="settings-row tpol-tool" data-class={t.class}>
                    <div className="settings-row-main">
                      <span className="settings-row-name">{c.kind === "realm" ? t.tool : toolLabel(t.tool)}</span>
                      <span className="settings-row-detail">{[toolNote(c, t), todayWords(t)].filter(Boolean).join(" · ")}</span>
                    </div>
                    <span className="tpol-value">{CLASS_SHORT[t.class]}</span>
                  </li>
                ))];
              })}
            </ul>

            <h3 className="settings-head">Also in force</h3>
            <ul className="settings-list">
              <li className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">Shell commands and web fetches</span>
                  <span className="settings-row-detail">They follow each role's mode, and ask. A Codex role's commands run with no network; one that needs it asks.</span>
                </div>
              </li>
              <li className="settings-row tp-row-link">
                <button type="button" className="tp-row-button tv-row" onClick={() => setSpacePageTab(spaceId, "vault")}>
                  <span className="tv-text">
                    <span className="tv-name">Sign-ins and keys</span>
                    <span className="tv-detail">Used only as the Vault allows</span>
                  </span>
                  <span className="tpol-value">Vault</span>
                  <Icon name="chevronRight" size={16} className="tpol-chevron" />
                </button>
              </li>
              <li className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">Outward actions</span>
                  <span className="settings-row-detail">{team.actsHeld ? "Nothing posts or sends until you let them go, in Review" : "Approved posts, DMs and email go at their slots once pressed"}</span>
                </div>
                <span className="tpol-value">{team.actsHeld ? "Held" : "Not held"}</span>
              </li>
            </ul>
          </>
        )}
      </div>
    </>
  );
}

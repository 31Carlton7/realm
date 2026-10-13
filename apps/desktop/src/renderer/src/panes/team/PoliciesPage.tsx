import { Icon, isIconName } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACT_PACING, AUTO_CAP_PREFILL, CLASS_FLOORS, POLICY_DECISIONS, POLICY_DECISION_WORDS, RISK_CLASSES, autoCeiling,
  floorFor, policyRowProblem, riskRank, tighterDecision, toolScopeKey,
  type PolicyCaps, type PolicyCover, type PolicyDecision, type PolicyScope, type RiskClass, type TeamPolicies, type TeamPolicyInput,
  type TeamPolicyRow, type TeamPolicyTool, type TeamSpace, type ToolClassInput,
} from "@realm/contracts";
import { Menu } from "../../components/Menu";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";
import { policiesClient } from "./policies-client";
import {
  ACT_ROWS, CLASS_ANSWER, CLASS_DOING, CLASS_SHORT, VERB_WORDS, capsLine, checksLine, classLoweringWords, classRows, connectorSource,
  connectorSummary, coverOf, loosens, looseningWords, needsCap, rowInForce, toolLabel, toolNote, verbDoing,
} from "./policies-format";

/** What an agent driving Realm's window may not press, named as `app_act`'s refusal names it. */
export const POLICIES_NO_AGENT = "team policy";

/** One tool on the page, with the connector it really belongs to — Realm's toolsets are drawn as one
 *  connection, and a rule for one of their tools still names its own provider. */
type PageTool = TeamPolicyTool & { connector: string; owner: string; label: string };
type Connection = { key: string; kind: "realm" | "server"; name: string; icon: string | null; reached: boolean; tools: PageTool[]; real: string | null };

/** A change of rule the person picked, held while its sheet asks whether they mean it. */
type PolicyChange = {
  kind: "policy"; scope: PolicyScope; scopeKey: string; to: PolicyDecision; from: PolicyDecision;
  /** What a role would do, after "Let Versed's roles …". */
  doing: string; cover: PolicyCover; existing: TeamPolicyRow | undefined;
};
type ClassChange = { kind: "tool-class"; connector: string; tool: string; label: string; to: RiskClass; from: RiskClass; then: PolicyDecision };
type Change = PolicyChange | ClassChange;

const errorWords = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const needsPress = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "POLICY_NEEDS_PRESS";

/** The row a policy change writes. Built once and handed to the press and the write alike, because
 *  main's seal covers exactly these bytes. */
function rowFor(spaceId: string, c: PolicyChange, perDay: number | null): TeamPolicyInput {
  const kept = c.existing;
  let caps: PolicyCaps = {};
  if (c.to === "auto" && perDay !== null) caps = { perDay, gapMs: kept?.decision === "auto" ? kept.caps.gapMs ?? AUTO_CAP_PREFILL.gapMs : AUTO_CAP_PREFILL.gapMs };
  else if (c.to === "ticket") {
    const pacing = c.scope === "verb" ? ACT_PACING[c.scopeKey as keyof typeof ACT_PACING] : undefined;
    caps = kept && Object.keys(kept.caps).length > 0 ? kept.caps : pacing ? { perDay: pacing.perDay, gapMs: pacing.gapMs } : {};
  }
  return { spaceId, scope: c.scope, scopeKey: c.scopeKey, decision: c.to, caps, checks: c.to === "block" ? [] : kept?.checks ?? [] };
}

/** The most "without asking" may be set to for what a row covers: the code ceiling of each irreversible
 *  verb under it, and the page's own prefill otherwise. */
function capPrefill(c: PolicyChange): number {
  if (c.existing?.decision === "auto" && c.existing.caps.perDay !== undefined) return c.existing.caps.perDay;
  return Math.min(AUTO_CAP_PREFILL.perDay!, ...c.cover.irreversibleVerbs.map((v) => autoCeiling(v).perDay));
}

/**
 * The team's Policies page (the dynamic-Teams plan, §7): what each kind of action, each connection and
 * each tool a role here could call does — goes ahead, asks, waits for Review and a press, or never runs.
 *
 * Tightening a rule applies at once. Loosening one opens a sheet that says what it costs, and only then
 * does main ask macOS for the person and seal exactly the row the write then sends; the server refuses
 * the write without that seal. Every control that changes a rule, and the sheet, carries `data-no-agent`.
 */
export function PoliciesPage({ spaceId, team }: { spaceId: string; team: TeamSpace }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const [data, setData] = useState<TeamPolicies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);

  const load = useCallback(async () => {
    try { setData(await policiesClient().view(spaceId)); setError(null); } catch (e) { setError(errorWords(e)); }
  }, [spaceId]);
  useEffect(() => {
    let live = true;
    policiesClient().view(spaceId).then((v) => { if (live) { setData(v); setError(null); } }, (e: unknown) => { if (live) setError(errorWords(e)); });
    return () => { live = false; };
  }, [spaceId, team]);

  const teamName = data?.spaceName ?? space?.name ?? "this team";

  // Realm's toolsets read as ONE connection: the person connected none of them, and fifteen rows of
  // built-ins would bury the servers they did connect. It has no rule of its own, since no one
  // connector stands behind it; each of its tools keeps its provider for its own rule.
  const connections = useMemo<Connection[]>(() => {
    if (!data) return [];
    const of = (c: TeamPolicies["connectors"][number], merged: boolean): PageTool[] =>
      c.tools.map((t) => ({ ...t, connector: c.connector, owner: c.name, label: merged ? `${c.name}: ${toolLabel(t.tool, c.name)}` : toolLabel(t.tool) }));
    const realm = data.connectors.filter((c) => c.kind === "realm");
    const merged: Connection[] = realm.length === 0 ? [] : [{
      key: "realm", kind: "realm", name: "Realm", icon: null, reached: true, real: null, tools: realm.flatMap((c) => of(c, true)),
    }];
    return [...merged, ...data.connectors.filter((c) => c.kind === "server").map((c): Connection => ({
      key: c.connector, kind: "server", name: c.name, icon: c.icon, reached: c.reached, real: c.connector, tools: of(c, false),
    }))];
  }, [data]);
  const rows = useMemo(() => (data ? classRows(data.connectors) : []), [data]);
  const allTools = useMemo(() => connections.flatMap((c) => c.tools), [connections]);
  const total = allTools.length;
  const irreversible = allTools.filter((t) => t.class === "irreversible-external").length;

  const stored = (scope: PolicyScope, key: string) => data?.rows.find((r) => r.scope === scope && r.scopeKey === key);
  const inForce = (scope: PolicyScope, key: string, floor: PolicyDecision) => rowInForce(stored(scope, key), floor, data?.sealsChecked ?? false);

  /** A pick from one of the page's menus: a tightening writes at once, a loosening opens the sheet. If
   *  the server holds that what looked tighter loosens after all, the sheet opens then. */
  const pick = async (c: PolicyChange) => {
    if (!loosens(c.to, c.from) && !needsCap(c.to, c.cover)) {
      try { await policiesClient().set(rowFor(spaceId, c, null)); setError(null); await load(); return; } catch (e) {
        if (!needsPress(e)) { setError(errorWords(e)); return; }
      }
    }
    setChange(c);
  };
  const pickClass = async (c: ClassChange) => {
    if (riskRank(c.to) < riskRank(c.from)) { setChange(c); return; }
    try { await policiesClient().setToolClass({ spaceId, connector: c.connector, tool: c.tool, class: c.to }); setError(null); await load(); } catch (e) {
      if (needsPress(e)) setChange(c); else setError(errorWords(e));
    }
  };

  const toolChange = (t: PageTool, to: PolicyDecision): PolicyChange => ({
    kind: "policy", scope: "tool", scopeKey: toolScopeKey(t.connector, t.tool), to, from: t.decision,
    doing: `run ${t.owner}'s ${toolLabel(t.tool, t.owner)}`, cover: coverOf([t]), existing: stored("tool", toolScopeKey(t.connector, t.tool)),
  });

  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Policies</h1></div>
        <span className="page-vantage t-num">{data ? `${total} tools · ${irreversible} can't be taken back` : ""}</span>
      </header>
      <div className="form">
        <p className="tp-lede">What {teamName}'s roles may do without you. Only you can change this page; loosening a rule asks macOS first.</p>
        {error && <p className="settings-hint" role="alert">{error}</p>}
        {!data ? (!error && <p className="tp-empty">Loading…</p>) : (
          <>
            <h3 className="settings-head">By kind of action</h3>
            <ul className="settings-list">
              {rows.map((r) => {
                const floor = CLASS_FLOORS[r.class];
                const now = inForce("class", r.class, floor);
                // Something that can't be taken back skips the click only per tool or per connection.
                const options = r.class === "irreversible-external" ? POLICY_DECISIONS.filter((d) => d !== "auto") : POLICY_DECISIONS;
                const split = r.today.includes(" · ") ? ` · today ${r.today}` : "";
                return (
                  <li key={r.class} className="settings-row" data-class={r.class}>
                    <div className="settings-row-main">
                      <span className="settings-row-name">{r.words}</span>
                      <span className="settings-row-detail">{r.examples.length > 0 ? r.examples.join(" · ") + split : "Nothing a role here can call does this"}</span>
                      {now.unconfirmed && <Unconfirmed floor={floor} />}
                    </div>
                    <DecisionPick label={r.words} value={now.decision} options={options}
                      onPick={(to) => { if (to !== now.decision || now.unconfirmed) void pick({ kind: "policy", scope: "class", scopeKey: r.class, to, from: now.decision, doing: CLASS_DOING[r.class], cover: coverOf(allTools.filter((t) => t.class === r.class), [r.class]), existing: stored("class", r.class) }); }} />
                  </li>
                );
              })}
            </ul>

            <h3 className="settings-head">Posts, DMs and email</h3>
            <ul className="settings-list">
              {verbRows(data.rows).length === 0 ? ACT_ROWS.map((a) => (
                <li key={a.label} className="settings-row">
                  <div className="settings-row-main">
                    <span className="settings-row-name">{a.label}</span>
                    <span className="settings-row-detail">{a.detail}</span>
                  </div>
                  <span className="tpol-value">You approve, then press each one</span>
                </li>
              )) : verbRows(data.rows).map((v) => {
                const now = rowInForce(v, "ask", data.sealsChecked);
                const caps = capsLine(v.caps);
                const checks = checksLine(v.checks);
                return (
                  <li key={v.scopeKey} className="settings-row" data-verb={v.scopeKey}>
                    <div className="settings-row-main">
                      <span className="settings-row-name">{VERB_WORDS[v.scopeKey]}</span>
                      {caps && <span className="settings-row-detail t-num">{caps}</span>}
                      {checks && <span className="settings-row-detail">{checks}</span>}
                      {now.unconfirmed && <Unconfirmed floor="ask" />}
                    </div>
                    <DecisionPick label={VERB_WORDS[v.scopeKey]!} value={now.decision} options={["ticket", "block"]}
                      onPick={(to) => { if (to !== now.decision) void pick({ kind: "policy", scope: "verb", scopeKey: v.scopeKey, to, from: now.decision, doing: verbDoing(v.scopeKey), cover: { classes: ["irreversible-external"], irreversibleVerbs: [v.scopeKey] }, existing: v }); }} />
                  </li>
                );
              })}
            </ul>

            <h3 className="settings-head">Connections</h3>
            <ul className="settings-list">
              {connections.flatMap((c) => {
                const expanded = open === c.key;
                const floor = c.tools.reduce<PolicyDecision>((d, t) => tighterDecision(d, floorFor({ class: t.class, asksFirst: t.asksFirst !== null })), "auto");
                const row = c.real ? stored("connector", c.real) : undefined;
                const now = c.real ? inForce("connector", c.real, floor) : null;
                const agreed = c.tools.length > 0 && c.tools.every((t) => t.decision === c.tools[0]!.decision) ? c.tools[0]!.decision : null;
                const shown = row && now ? now.decision : agreed;
                const tightest = c.tools.reduce<PolicyDecision>((d, t) => tighterDecision(d, t.decision), now?.decision ?? "auto");
                const head = (
                  <li key={c.key} className="settings-row tp-row-link tpol-connector">
                    <button type="button" className="tp-row-button tv-row" aria-expanded={expanded} disabled={c.tools.length === 0}
                      onClick={() => setOpen(expanded ? null : c.key)}>
                      <span className="tv-glyph">
                        {c.icon && isIconName(c.icon) ? <Icon name={c.icon} size={16} colored /> : <Icon name={c.kind === "realm" ? "tool" : "serverStack"} size={16} />}
                      </span>
                      <span className="tv-text">
                        <span className="tv-name">{c.name}</span>
                        <span className="tv-detail">{connectorSource(c)}{now?.unconfirmed ? " · Not confirmed on this Mac" : ""}</span>
                      </span>
                      <span className="tpol-value t-num">{connectorSummary(c)}</span>
                      {c.tools.length > 0 && <Icon name={expanded ? "chevronUp" : "chevronDown"} size={16} className="tpol-chevron" />}
                    </button>
                    {c.real && (
                      <DecisionPick label={c.name} value={shown} options={POLICY_DECISIONS}
                        onPick={(to) => {
                          if (row && now && to === now.decision && !now.unconfirmed) return;
                          void pick({ kind: "policy", scope: "connector", scopeKey: c.real!, to, from: tightest, doing: `use ${c.name}`, cover: coverOf(c.tools), existing: row });
                        }} />
                    )}
                  </li>
                );
                if (!expanded) return [head];
                const tools = [...c.tools].sort((a, b) => riskRank(b.class) - riskRank(a.class) || a.label.localeCompare(b.label));
                return [head, ...tools.map((t) => (
                  <li key={`${t.connector}#${t.tool}`} className="settings-row tpol-tool" data-class={t.class}>
                    <div className="settings-row-main">
                      <span className="settings-row-name">{t.label}</span>
                      <span className="settings-row-detail">{toolNote({ name: t.owner }, t)}</span>
                      {t.unconfirmed && <Unconfirmed floor={floorFor({ class: t.class, asksFirst: t.asksFirst !== null })} />}
                    </div>
                    {t.source === "unclassified" || t.source === "you"
                      ? <ClassPick tool={t} onPick={(to) => {
                          if (to === t.class && t.source === "you") return;
                          void pickClass({ kind: "tool-class", connector: t.connector, tool: t.tool, label: `${t.owner}'s ${toolLabel(t.tool, t.owner)}`, to, from: t.class,
                            then: inForce("class", to, CLASS_FLOORS[to]).decision });
                        }} />
                      : <span className="tpol-value">{CLASS_SHORT[t.class]}</span>}
                    <DecisionPick label={t.label} value={t.decision} options={POLICY_DECISIONS}
                      onPick={(to) => { if (to !== t.decision || t.decidedBy !== "tool" || t.unconfirmed) void pick(toolChange(t, to)); }} />
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
      {change && data && (
        <ChangeSheet change={change} spaceId={spaceId} teamName={teamName} profileId={data.profileId ?? space?.profileId ?? null}
          onClose={() => setChange(null)} onDone={async () => { setChange(null); await load(); }} />
      )}
    </>
  );
}

/** The team's rows for posts, DMs and email, in that order. */
const verbRows = (rows: readonly TeamPolicyRow[]): TeamPolicyRow[] =>
  ["post", "dm", "email"].flatMap((v) => rows.filter((r) => r.scope === "verb" && r.scopeKey === v));

function Unconfirmed({ floor }: { floor: PolicyDecision }) {
  return (
    <span className="settings-row-detail" title={`A looser rule is kept for this, but it holds no seal from this Mac, so “${POLICY_DECISION_WORDS[floor]}” stands.`}>
      Not confirmed on this Mac
    </span>
  );
}

/** A rule's decision: the value in force and a chevron, opening the system's menu of the decisions this
 *  rule may say. `null` is a connection with no rule of its own whose tools say different things. */
function DecisionPick({ label, value, options, onPick }: {
  label: string; value: PolicyDecision | null; options: readonly PolicyDecision[]; onPick: (d: PolicyDecision) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const words = value ? POLICY_DECISION_WORDS[value] : "As above";
  return (
    <>
      <button type="button" ref={ref} className="btn-quiet tpol-pick" aria-haspopup="menu" aria-expanded={open}
        aria-label={`${label}: ${words}`} title={value ? undefined : "Each tool follows its kind of action"}
        data-no-agent={POLICIES_NO_AGENT} onClick={() => setOpen((o) => !o)}>
        {words}<Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <Menu anchorRef={ref} align="right" label={label} onClose={() => setOpen(false)}
          items={options.map((d) => ({ label: POLICY_DECISION_WORDS[d], checked: d === value, onSelect: () => onPick(d), noAgent: POLICIES_NO_AGENT }))} />
      )}
    </>
  );
}

/** "What does this do?" — the person's word on a tool Realm could not class, or one they classed before. */
function ClassPick({ tool, onPick }: { tool: PageTool; onPick: (c: RiskClass) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const said = tool.source === "you";
  return (
    <>
      <button type="button" ref={ref} className="btn-quiet tpol-pick" aria-haspopup="menu" aria-expanded={open}
        aria-label={`What does ${tool.label} do?`} data-no-agent={POLICIES_NO_AGENT} onClick={() => setOpen((o) => !o)}>
        {said ? CLASS_SHORT[tool.class] : "What does this do?"}<Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <Menu anchorRef={ref} align="right" label={`What ${tool.label} does`} onClose={() => setOpen(false)}
          items={RISK_CLASSES.map((c) => ({ label: CLASS_ANSWER[c], checked: said ? c === tool.class : undefined, onSelect: () => onPick(c), noAgent: POLICIES_NO_AGENT }))} />
      )}
    </>
  );
}

/**
 * A loosening, in the vault's grammar: the question, a sentence of what it costs, the decision at the
 * right. "Without asking" on anything elsewhere takes a daily limit here, and a limit past what Realm
 * allows is refused on the sheet, before macOS is asked anything. Then main asks macOS, seals the exact
 * row, and the write spends the seal.
 */
function ChangeSheet({ change, spaceId, teamName, profileId, onClose, onDone }: {
  change: Change; spaceId: string; teamName: string; profileId: string | null; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [perDay, setPerDay] = useState(() => (change.kind === "policy" ? String(capPrefill(change)) : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = policiesClient();

  const capped = change.kind === "policy" && needsCap(change.to, change.cover);
  const n = /^\d+$/.test(perDay.trim()) ? Number(perDay.trim()) : null;
  let words: { title: string; body: string; button: string; reason: string };
  let problem: string | null = null;
  let row: TeamPolicyInput | null = null;
  if (change.kind === "policy") {
    words = looseningWords({ team: teamName, doing: change.doing, to: change.to, from: change.from, perDay: capped ? n : null,
      irreversible: change.cover.classes.includes("irreversible-external") });
    if (capped && (n === null || n < 1)) problem = "Say how many times a day, at most.";
    else {
      row = rowFor(spaceId, change, capped ? n : null);
      problem = policyRowProblem(row, change.cover);
    }
  } else {
    words = classLoweringWords({ tool: change.label, to: change.to, from: change.from, then: change.then });
    if (!profileId) problem = "This space belongs to no profile, so Realm has nowhere to keep your word.";
  }

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      if (change.kind === "policy") {
        if (!row) return;
        const pressed = await c.press({ kind: "policy", row, reason: words.reason });
        if (!pressed.ok) { setError(pressed.error); return; }
        await c.set(row);
      } else {
        const classRow: ToolClassInput = { spaceId, connector: change.connector, tool: change.tool, class: change.to };
        const pressed = await c.press({ kind: "tool-class", profileId: profileId!, row: classRow, reason: words.reason });
        if (!pressed.ok) { setError(pressed.error); return; }
        await c.setToolClass(classRow);
      }
      await onDone();
    } catch (e) { setError(errorWords(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet title={words.title} onClose={onClose} width={520}
      footer={<div className="tv-foot" data-no-agent={POLICIES_NO_AGENT}>
        {error && <span className="tp-sheet-error" role="alert">{error}</span>}
        <span className="diff-head-spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || problem !== null} onClick={() => { void confirm(); }}>
          {busy && <Spinner size={12} />}{words.button}
        </button>
      </div>}>
      <div className="form unlock-confirm" data-no-agent={POLICIES_NO_AGENT}>
        <p>{words.body}</p>
        {capped && (
          <label className="field">
            <span>Times a day, at most</span>
            <input type="number" inputMode="numeric" min={1} value={perDay} onChange={(e) => setPerDay(e.target.value)} aria-invalid={problem !== null || undefined} />
          </label>
        )}
        {problem && <p className="tp-sheet-error" role="alert">{problem}</p>}
        <p className="settings-hint">macOS asks for Touch ID or your login password to turn this on.</p>
      </div>
    </Sheet>
  );
}

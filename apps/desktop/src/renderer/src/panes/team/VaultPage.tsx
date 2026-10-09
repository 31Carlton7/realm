import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserCredential, TeamRole, TeamSpace, VaultAllow, VaultGrant, VaultUse } from "@realm/contracts";
import { Menu } from "../../components/Menu";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";
import { feedTime } from "./team-format";
import { vaultClient, type VaultListing } from "./vault-client";
import { signinTitle, useLine, vaultEntries, type VaultEntry } from "./vault-format";

/** What an agent driving Realm's window may not press, named as `app_act`'s refusal names it. */
const NO_AGENT = "team vault grant";

type Loaded = { listing: VaultListing; grants: VaultGrant[]; uses: VaultUse[] };

/**
 * The team's Vault (the Teams plan, 13.4 and mock 06): what the team's roles may use, by name — its
 * sign-ins, then what was used lately (the trust story, so it comes before the keys), then its API keys.
 * A row opens its grant sheet, where the person says which roles may use it, where, and whether a role
 * may use it on this Mac without asking.
 *
 * Two sources and no third: the secrets and the allows are main's (the values are there and never come
 * back); grants and uses are realm-server's, which holds no secret. Every control that adds a secret or
 * lets a role through without asking carries `data-no-agent`.
 */
export function VaultPage({ spaceId, team }: { spaceId: string; team: TeamSpace }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const profileId = space?.profileId ?? "";
  const profileName = useApp((s) => s.profiles.find((p) => p.id === profileId)?.name ?? "this profile");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<"signin" | "key" | "saved" | null>(null);
  const [menu, setMenu] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const c = vaultClient();
      const [listing, grants, uses] = await Promise.all([c.list(profileId, spaceId), c.grants(spaceId), c.uses(spaceId)]);
      setData({ listing, grants, uses });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [profileId, spaceId]);
  // The team object changes on every `team.changed`, which a use or a grant broadcasts: read again then.
  useEffect(() => { void load(); }, [load, team]);

  const roleName = useCallback((id: string) => team.roles.find((r) => r.id === id)?.name ?? team.formerRoles.find((r) => r.id === id)?.name ?? null, [team]);
  const entries = useMemo(() => (data
    ? vaultEntries(data.listing.secrets, data.listing.allows, data.grants, data.uses, spaceId, roleName)
    : { signins: [], keys: [] }), [data, spaceId, roleName]);
  const all = [...entries.signins, ...entries.keys];
  const opened = all.find((e) => e.id === open)
    ?? (open && data ? savedAsEntry(data.listing.secrets.signins.find((s) => s.id === open), spaceId) : undefined);

  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Vault</h1></div>
        <span className="page-vantage t-num">{data ? `${all.length} secret${all.length === 1 ? "" : "s"} · Keychain` : ""}</span>
        <button type="button" ref={addRef} className="btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} data-no-agent={NO_AGENT}>
          <Icon name="add" size={16} />Add…
        </button>
        {menu && (
          <Menu anchorRef={addRef} align="right" label="Add to the vault" onClose={() => setMenu(false)} items={[
            { label: "Sign-in…", detail: "A password Realm types into the page", onSelect: () => setAdding("signin"), noAgent: NO_AGENT },
            { label: "API key…", detail: "A key Realm puts into one request it makes", onSelect: () => setAdding("key"), noAgent: NO_AGENT },
            { kind: "separator" },
            { label: "From your sign-ins…", detail: `One of ${profileName}'s, for a role here to use`, onSelect: () => setAdding("saved"), noAgent: NO_AGENT },
          ]} />
        )}
      </header>
      <div className="form">
        <p className="tp-lede">Agents use these by name. Realm types a sign-in into the page, or puts a key into one request it makes; the agent never receives the value.</p>
        {error && <p className="settings-hint" role="alert">{error}</p>}
        {data && !data.listing.available && <p className="settings-hint">macOS is not offering Realm a Keychain key right now, so nothing can be added or used.</p>}
        {!data ? <p className="tp-empty">Loading…</p> : (
          <>
            <h3 className="settings-head">Sign-ins</h3>
            {entries.signins.length === 0
              ? <p className="tp-empty">No sign-ins yet. Add one, or give a role one of {profileName}'s.</p>
              : <SecretList entries={entries.signins} onOpen={setOpen} />}
            <h3 className="settings-head">Recent use</h3>
            {data.uses.length === 0 ? <p className="tp-empty">Nothing has used the vault yet.</p> : <UseTable uses={data.uses} team={team} />}
            <h3 className="settings-head">Keys</h3>
            {entries.keys.length === 0
              ? <p className="tp-empty">No API keys yet. A key is locked to the hosts you name, and only Realm sends it.</p>
              : <SecretList entries={entries.keys} onOpen={setOpen} />}
          </>
        )}
      </div>
      {opened && data && (
        <GrantSheet key={opened.id} entry={opened} team={team} spaceId={spaceId} profileId={profileId} profileName={profileName}
          profileUnattended={data.listing.profileUnattended} onChanged={load} onClose={() => setOpen(null)} />
      )}
      {adding && (
        <AddSheet kind={adding} spaceId={spaceId} profileId={profileId} profileName={profileName}
          offered={(data?.listing.secrets.signins ?? []).filter((s) => s.spaceId === null && !all.some((e) => e.id === s.id))}
          onClose={() => setAdding(null)}
          onMade={(id) => { setAdding(null); void load().then(() => setOpen(id)); }} />
      )}
    </>
  );
}

/** A profile's sign-in picked from Add ▸ "From your sign-ins" has no row until a role is granted it;
 *  its sheet still opens, drawn from the listing. */
function savedAsEntry(s: VaultListing["secrets"]["signins"][number] | undefined, spaceId: string): VaultEntry | undefined {
  if (!s) return undefined;
  return vaultEntries({ signins: [{ ...s, spaceId }], keys: [] }, [], [], [], spaceId, () => null).signins.map((e) => ({ ...e, teamOwned: false }))[0];
}

function SecretList({ entries, onOpen }: { entries: VaultEntry[]; onOpen: (id: string) => void }) {
  return (
    <ul className="settings-list tv-list">
      {entries.map((e) => (
        <li key={e.id} className="settings-row tp-row-link">
          <button type="button" className="tp-row-button tv-row" onClick={() => onOpen(e.id)} aria-label={`${e.name} — ${e.detail}. Who may use it`}>
            <span className="tv-glyph"><Icon name={e.glyph} size={16} /></span>
            <span className="tv-text">
              <span className="tv-name">{e.name}</span>
              <span className="tv-detail">{e.detail}</span>
            </span>
            {e.allows.length > 0 && <span className="tp-chip" data-tone="warn" title="A role uses it on this Mac without asking">Without asking</span>}
            {e.lastUsed !== null && <span className="tv-used t-num">Used {feedTime(e.lastUsed)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function UseTable({ uses, team }: { uses: VaultUse[]; team: TeamSpace }) {
  return (
    <table className="tp-table tv-uses">
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Where</th><th /></tr></thead>
      <tbody>
        {uses.slice(0, 12).map((u) => {
          const role = u.roleId ? team.roles.find((r) => r.id === u.roleId) ?? team.formerRoles.find((r) => r.id === u.roleId) : undefined;
          const line = useLine(u);
          return (
            <tr key={u.id}>
              <td className="t-dim t-num">{feedTime(u.ts)}</td>
              <td>
                <span className="tv-who">
                  {role ? <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={16} /> : <Icon name="user" size={12} />}
                  {role?.name ?? "Your session"}
                </span>
              </td>
              <td className="tv-what">{line.what}</td>
              <td className="t-dim tv-where">{line.where}{u.how === "unattended" ? " · without asking" : ""}</td>
              <td><span className="tp-chip" data-tone={line.chip.tone}>{line.chip.word}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ═══════════════════════════════ a secret's grants ═══════════════════════════════ */

/**
 * Who may use one secret. A role's row says whether it may, at which of the secret's hosts, and — once
 * it may — whether it asks on its card each time or uses it here without asking. Turning that last one
 * on is never one click: the sheet turns into the sentence of what it costs, and main asks macOS to
 * confirm the person. Turning it off is one click, and so is taking the grant away.
 */
function GrantSheet({ entry, team, spaceId, profileId, profileName, profileUnattended, onChanged, onClose }: {
  entry: VaultEntry; team: TeamSpace; spaceId: string; profileId: string; profileName: string; profileUnattended: boolean;
  onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ role: TeamRole; grant: VaultGrant } | null>(null);
  const [removing, setRemoving] = useState(false);
  const c = vaultClient();
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const allowOf = (roleId: string, grant: VaultGrant | undefined): VaultAllow | undefined =>
    grant ? entry.allows.find((a) => a.roleId === roleId && a.grantAt === grant.createdAt) : undefined;

  if (confirming) {
    const { role, grant } = confirming;
    const turnOn = () => act(`allow:${role.id}`, async () => {
      const r = await c.setAllow(profileId, { spaceId, secretId: entry.id, roleId: role.id, hosts: grant.hosts, grantAt: grant.createdAt, roleName: role.name, secretName: entry.name });
      if (!r.ok) throw new Error(r.error);
      await c.allowChanged(spaceId, entry.id, role.id);
      setConfirming(null);
    });
    return (
      <Sheet title={`Let ${role.name} use ${entry.name} without asking?`} onClose={() => setConfirming(null)} width={520}
        footer={<div className="tv-foot" data-no-agent={NO_AGENT}>
          {error && <span className="tp-sheet-error" role="alert">{error}</span>}
          <button type="button" className="btn" onClick={() => setConfirming(null)}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => { void turnOn(); }}>
            {busy && <Spinner size={12} />}Turn on for {role.name}
          </button>
        </div>}>
        <div className="form unlock-confirm" data-no-agent={NO_AGENT}>
          <div className="tp-remove-who">
            <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} />
            <span className="tp-card-name">{role.name}</span>
          </div>
          <p>
            {role.name} will {entry.kind === "key" ? `put ${entry.name} into requests to ${grant.hosts.join(", ")}` : `fill ${entry.name}`} on this Mac
            with no card in its session. Use this on a Mac set aside for the team's work, not with your personal accounts.
          </p>
          <ul className="unlock-confirm-list">
            <li>The agent still never receives the value. Realm types it, or sends it, itself.</li>
            <li>Only this secret, only for {role.name}, only at {grant.hosts.join(", ")}. Nothing else changes.</li>
            <li>Every use is a line in the team's Activity and in Realm's credential log.</li>
            <li>It works only on this Mac. Taking the grant away, or turning this off, brings the card back.</li>
            {!profileUnattended && <li>It takes effect once Settings ▸ Sign-ins unlocks {profileName}'s sign-ins without asking. Until then each use still asks for Touch ID, so the card stays.</li>}
          </ul>
          <p className="settings-hint">macOS asks for Touch ID or your login password to turn this on.</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={entry.name} onClose={onClose} width={560}
      footer={<div className="tv-foot">
        {error && <span className="tp-sheet-error" role="alert">{error}</span>}
        {entry.teamOwned && (removing
          ? <button type="button" className="btn destructive" data-no-agent={NO_AGENT} disabled={busy !== null}
              onClick={() => { void act("remove", async () => { await c.remove(profileId, spaceId, entry.id); onClose(); }); }}>Remove {entry.name} from the vault</button>
          : <button type="button" className="btn-quiet danger" data-no-agent={NO_AGENT} onClick={() => setRemoving(true)}>Remove from the vault…</button>)}
        <span className="diff-head-spacer" />
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </div>}>
      <div className="form" data-no-agent={NO_AGENT}>
        <p className="tp-lede">
          {entry.kind === "key"
            ? `API key, locked to ${entry.pinned.join(", ")}. Realm puts it into one request it makes; the agent never receives it.`
            : `Sign-in for ${entry.pinned[0]}. Realm types it into the page; the agent never receives it.`}
          {!entry.teamOwned && ` It is one of ${profileName}'s sign-ins; Settings ▸ Sign-ins keeps it.`}
        </p>
        <h3 className="settings-head">Who may use it</h3>
        {team.roles.length === 0 ? <p className="tp-empty">This team has no roles yet.</p> : (
          <ul className="settings-list tv-grants">
            {team.roles.map((role) => {
              const grant = entry.grants.find((g) => g.roleId === role.id);
              const allow = allowOf(role.id, grant);
              const hostsOn = grant?.hosts ?? [];
              return (
                <li key={role.id} className="tv-grant">
                  <div className="settings-row">
                    <span className="tv-grant-who"><Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} /></span>
                    <div className="settings-row-main tv-grant-main">
                      <span className="settings-row-name">{role.name}</span>
                      <span className="settings-row-detail">{!grant ? "May not use it" : allow ? `Uses it without asking on this Mac${profileUnattended ? "" : " — once Sign-ins unlock without asking"}` : "Asks on its card each time"}</span>
                    </div>
                    <input type="checkbox" role="switch" className="switch" checked={!!grant} disabled={busy !== null}
                      aria-label={`${role.name} may use ${entry.name}`}
                      onChange={(e) => {
                        const on = e.target.checked;
                        void act(`grant:${role.id}`, () => (on
                          ? c.grant({ spaceId, secretId: entry.id, roleId: role.id, hosts: [], purpose: null })
                          : c.revoke(spaceId, entry.id, role.id)));
                      }} />
                  </div>
                  {grant && entry.kind === "key" && entry.pinned.length > 1 && (
                    <div className="settings-row tv-hosts" role="group" aria-label={`Where ${role.name} may send it`}>
                      <div className="settings-row-main"><span className="settings-row-detail">Only to</span></div>
                      {entry.pinned.map((h) => {
                        const on = hostsOn.includes(h);
                        return (
                          <label key={h} className="tv-host" data-on={on || undefined}>
                            <input type="checkbox" checked={on} disabled={busy !== null || (on && hostsOn.length === 1)}
                              onChange={() => {
                                const next = on ? hostsOn.filter((x) => x !== h) : [...hostsOn, h];
                                void act(`hosts:${role.id}`, () => c.grant({ spaceId, secretId: entry.id, roleId: role.id, hosts: next, purpose: grant.purpose }));
                              }} />
                            {h}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {grant && (
                    <div className="settings-row tv-allow">
                      <div className="settings-row-main">
                        <span className="settings-row-name">Use without asking</span>
                        <span className="settings-row-detail">On this Mac only, for {role.name} alone</span>
                      </div>
                      <input type="checkbox" role="switch" className="switch tv-allow-switch" checked={!!allow} disabled={busy !== null}
                        aria-label={`${role.name} uses ${entry.name} without asking`}
                        onChange={(e) => {
                          if (e.target.checked) { setError(null); setConfirming({ role, grant }); return; }
                          void act(`allow:${role.id}`, async () => { await c.clearAllow(entry.id, role.id); await c.allowChanged(spaceId, entry.id, role.id); });
                        }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

/* ═══════════════════════════════ adding ═══════════════════════════════ */

/**
 * Add a sign-in or a key to the team, or give a role one of the profile's sign-ins. The value is typed
 * here and goes to main once; nothing on this page can show it again. The sheet that takes a secret is
 * where it says where the secret goes (design.md: "any surface that takes a credential shows where it
 * goes").
 */
function AddSheet({ kind, spaceId, profileId, profileName, offered, onClose, onMade }: {
  kind: "signin" | "key" | "saved"; spaceId: string; profileId: string; profileName: string;
  offered: (Pick<BrowserCredential, "id" | "origin" | "username" | "label">)[]; onClose: () => void; onMade: (id: string) => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = vaultClient();
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const made = kind === "signin"
        ? await c.addSignin(profileId, spaceId, { origin: a.trim(), username: b.trim(), label: label.trim(), value })
        : await c.addKey(profileId, spaceId, { name: a.trim(), allowedHosts: b.split(/[\s,]+/).filter(Boolean), label: label.trim(), value });
      setValue("");
      onMade(made.id);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally { setBusy(false); }
  };

  if (kind === "saved") {
    return (
      <Sheet title={`One of ${profileName}'s sign-ins`} onClose={onClose} width={520}>
        <div className="form" data-no-agent={NO_AGENT}>
          <p className="tp-lede">Pick one, then say which roles may use it. It stays {profileName}'s, in Settings ▸ Sign-ins.</p>
          {offered.length === 0 ? <p className="tp-empty">{profileName} has no other sign-ins saved.</p> : (
            <ul className="settings-list tv-list">
              {offered.map((s) => (
                <li key={s.id} className="settings-row tp-row-link">
                  <button type="button" className="tp-row-button tv-row" onClick={() => onMade(s.id)}>
                    <span className="tv-glyph"><Icon name="padlock" size={16} /></span>
                    <span className="tv-text">
                      <span className="tv-name">{signinTitle(s.origin, s.username)}</span>
                      {s.label && <span className="tv-detail">{s.label}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    );
  }

  const ready = a.trim() && value && (kind === "signin" || b.trim());
  return (
    <Sheet title={kind === "signin" ? "Add a sign-in" : "Add an API key"} onClose={onClose} width={520}
      footer={<div className="tv-foot" data-no-agent={NO_AGENT}>
        {error && <span className="tp-sheet-error" role="alert">{error}</span>}
        <span className="diff-head-spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => { void submit(); }}>{busy && <Spinner size={12} />}Save to the vault</button>
      </div>}>
      <form className="form" data-no-agent={NO_AGENT} onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
        {kind === "signin" ? (
          <>
            <label className="field"><span>Site</span><input value={a} onChange={(e) => setA(e.target.value)} placeholder="https://www.tiktok.com" autoFocus spellCheck={false} /></label>
            <label className="field"><span>Username</span><input value={b} onChange={(e) => setB(e.target.value)} placeholder="nathan" spellCheck={false} autoComplete="off" /></label>
            <label className="field"><span>For</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="@versed.nathan" /></label>
            <label className="field"><span>Password</span><input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" /></label>
          </>
        ) : (
          <>
            <label className="field"><span>Name</span><input value={a} onChange={(e) => setA(e.target.value)} placeholder="REVENUECAT_SECRET_KEY" autoFocus spellCheck={false} /></label>
            <label className="field"><span>Only to</span><input value={b} onChange={(e) => setB(e.target.value)} placeholder="api.revenuecat.com" spellCheck={false} /></label>
            <label className="field"><span>Note</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Read-only, for the weekly numbers" /></label>
            <label className="field"><span>Key</span><input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></label>
          </>
        )}
        <p className="tp-make-note">
          {kind === "signin"
            ? "Kept in this Mac's Keychain for this team alone. Realm types it only into a page on this site, and nobody, you included, can read it back here."
            : "Kept in this Mac's Keychain for this team alone. Realm sends it only to these hosts, over https, in a request it makes itself; a host that echoes it back gets it scrubbed from the answer."}
        </p>
      </form>
    </Sheet>
  );
}

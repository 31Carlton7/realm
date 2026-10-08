import { Icon, Realmite, parseRealmiteSpec, realmiteFromSeed } from "@realm/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ROLE_TEMPLATES, TEAM_DEFAULTS, teamShares, type CustomRoleInput, type RoleTemplate, type TeamSpace } from "@realm/contracts";
import { Sheet } from "../../components/Sheet";
import { RpcError } from "../../rpc/client";
import { useApp } from "../../state/store";
import { RoleSheet, modelLabel } from "./RoleSheet";
import { money, sharesNote, wakeSentence } from "./team-format";

/**
 * Choosing who is on a team: a gallery of starter roles, each a card that toggles, on two shelves —
 * roles any team can use, and the ones that work with creators — and the person's own teammates,
 * written in the role sheet and held here until the team is made. The same picker makes a team (the
 * Team tab of a space that is not one yet) and adds to one (Add teammate, from the team's pages and
 * from the sidebar's Team fold).
 *
 * The shares of the team's week are added up as the cards are picked — the sum the server holds the
 * team to — and when they pass the week, the picker says by how much and offers to raise it, rather
 * than letting the press be refused.
 */

const SHELVES: { group: RoleTemplate["group"]; head: string; note: string | null }[] = [
  { group: "any", head: "For any team", note: null },
  { group: "creators", head: "For work with creators", note: "These keep a record for each creator under creators/ in the team's memory." },
];

const firstSentence = (s: string) => {
  const t = s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  const cut = t.search(/[.!?](\s|$)/);
  return (cut > 0 ? t.slice(0, cut + 1) : t).replace(/`/g, "");
};

const foot = (cron: string | null, budget: number | null | undefined, model: string | null | undefined) =>
  [wakeSentence(cron ?? null), budget ? `${money(budget)} a week` : "no share of its own", modelLabel(model ?? null)].join(" · ");

type Picked = { templates: string[]; customs: CustomRoleInput[]; raised: number | null };

/** What the team's week comes to with the picks, against the week they are held to. */
function totals(team: TeamSpace | undefined, p: Picked): { shares: number; cap: number; templateShares: number; customShares: number } {
  const templateShares = p.templates.reduce((n, id) => n + (ROLE_TEMPLATES.find((t) => t.id === id)?.weekBudgetUsd ?? 0), 0);
  const customShares = p.customs.reduce((n, r) => n + (r.weekBudgetUsd ?? 0), 0);
  return { shares: teamShares(team?.roles ?? [], { add: [templateShares, customShares] }), cap: p.raised ?? team?.weekBudgetUsd ?? TEAM_DEFAULTS.teamWeekBudgetUsd, templateShares, customShares };
}

/** The cards. Templates already on the team stand lit and say so; a teammate written here can be
 *  opened again or taken off. */
function Gallery({ team, picked, setPicked, onWrite }: {
  team: TeamSpace | undefined;
  picked: Picked;
  setPicked: (f: (p: Picked) => Picked) => void;
  /** Open the role sheet: a new teammate (null) or the one at this index. */
  onWrite: (index: number | null) => void;
}) {
  const onTeam = new Set((team?.roles ?? []).map((r) => r.name.toLowerCase()));
  const toggle = (id: string, on: boolean) => setPicked((p) => ({ ...p, templates: on ? [...p.templates, id] : p.templates.filter((x) => x !== id) }));
  return (
    <>
      {SHELVES.map((shelf) => (
        <section key={shelf.group} className="tp-shelf" aria-label={shelf.head}>
          <h3 className="settings-head">{shelf.head}</h3>
          {shelf.note && <p className="tp-make-note tp-shelf-note">{shelf.note}</p>}
          <div className="tp-cards">
            {ROLE_TEMPLATES.filter((t) => t.group === shelf.group).map((t) => {
              const there = onTeam.has(t.name.toLowerCase());
              const on = picked.templates.includes(t.id);
              const Card = there ? "div" : "label";
              return (
                <Card key={t.id} className="tp-card tp-pick" data-on={on || undefined} data-there={there || undefined} data-template={t.id}>
                  <span className="tp-card-head">
                    <span className="tp-mark"><Realmite spec={realmiteFromSeed(t.realmiteSeed)} size={32} /></span>
                    <span className="tp-card-name">{t.name}</span>
                    {there
                      ? <span className="tp-chip tp-pick-box">On the team</span>
                      : <input type="checkbox" className="checkbox tp-pick-box" checked={on} aria-label={`Add ${t.name}`} onChange={(e) => toggle(t.id, e.target.checked)} />}
                  </span>
                  <span className="tp-card-line">{t.blurb}</span>
                  <span className="tp-card-foot">{foot(t.cron, t.weekBudgetUsd, t.model)}</span>
                </Card>
              );
            })}
            {/* A teammate of your own stands with the roles any team can use: the first shelf, where it is seen. */}
            {shelf.group === "any" && <>
              {picked.customs.map((r, i) => (
                <div key={`${r.name}-${i}`} className="tp-card tp-pick" data-on="" data-custom="">
                  <span className="tp-card-head">
                    <span className="tp-mark"><Realmite spec={parseRealmiteSpec(r.realmite, r.name)} size={32} /></span>
                    <span className="tp-card-name">{r.name}</span>
                    <span className="tp-pick-acts">
                      <button type="button" className="btn-quiet" onClick={() => onWrite(i)}>Edit</button>
                      <button type="button" className="icon-btn" aria-label={`Take ${r.name} off the list`} title={`Take ${r.name} off the list`}
                        onClick={() => setPicked((p) => ({ ...p, customs: p.customs.filter((_, j) => j !== i) }))}><Icon name="close" size={14} /></button>
                    </span>
                  </span>
                  <span className="tp-card-line">{firstSentence(r.brief)}</span>
                  <span className="tp-card-foot">{foot(r.cron ?? null, r.weekBudgetUsd, r.model)}</span>
                </div>
              ))}
              <button type="button" className="tp-card tp-card-custom" onClick={() => onWrite(null)}>
                <span className="tp-card-head">
                  <span className="tp-mark tp-mark-add"><Icon name="add" size={16} /></span>
                  <span className="tp-card-name">Custom teammate</span>
                </span>
                <span className="tp-card-line">Write your own: what they do, when they wake, what they may spend, and their Realmite.</span>
              </button>
            </>}
          </div>
        </section>
      ))}
    </>
  );
}

/** The week, as the picks divide it, and — once they pass it — the offer to raise it to fit. */
function SharesFoot({ team, picked, setPicked, children }: { team: TeamSpace | undefined; picked: Picked; setPicked: (f: (p: Picked) => Picked) => void; children: ReactNode }) {
  const { shares, cap } = totals(team, picked);
  const note = sharesNote(shares, cap);
  return (
    <div className="tp-picker-foot">
      <span className="tp-shares-line" data-over={note.over || undefined}>
        <span className="t-num" role="status">{note.text}</span>
        <span className="tp-meter tp-meter-wide" data-high={note.over || undefined} aria-hidden="true"><i style={{ width: `${note.pct}%` }} /></span>
        {note.over && (
          <button type="button" className="btn-quiet" onClick={() => setPicked((p) => ({ ...p, raised: Math.ceil(shares) }))}>
            Raise the team's week to {money(Math.ceil(shares))}
          </button>
        )}
      </span>
      {children}
    </div>
  );
}

const count = (p: Picked) => p.templates.length + p.customs.length;
const teammates = (n: number) => (n === 1 ? "1 teammate" : `${n} teammates`);

/** The role sheet in picker mode: Save hands the teammate back, and nothing is made until the team is. */
function DraftSheet({ spaceId, team, picked, index, onSave, onClose }: {
  spaceId: string; team: TeamSpace | undefined; picked: Picked; index: number | null;
  onSave: (r: CustomRoleInput) => void; onClose: () => void;
}) {
  const t = totals(team, picked);
  const mine = index === null ? 0 : picked.customs[index]?.weekBudgetUsd ?? 0;
  return (
    <RoleSheet spaceId={spaceId} team={team} draft={index === null ? undefined : picked.customs[index]}
      otherShares={t.shares - mine} cap={t.cap} onDraft={onSave} onClose={onClose} />
  );
}

/* ═══════════════════════════════ making a team ═══════════════════════════════ */

/**
 * A space that is not a team yet: what a team is in two sentences, the gallery, and one primary that
 * makes it — landing on the Overview with them in it. Where the team's memory can go nowhere Realm
 * would put it (Realm's own folder is inside a project), it says so where the button is and offers
 * the one fix: choose a folder.
 */
export function MakeTeam({ spaceId }: { spaceId: string }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const team = useApp((s) => s.teams[spaceId]);
  const makeTeam = useApp((s) => s.makeTeam);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const pickFolder = useApp((s) => s.pickFolder);
  const toast = useApp((s) => s.toast);
  const run = useApp((s) => s.run);
  const [picked, setPicked] = useState<Picked>({ templates: [], customs: [], raised: null });
  const [writing, setWriting] = useState<number | null | false>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const over = sharesNote(totals(team, picked).shares, totals(team, picked).cap).over;
  // What went wrong is said where the button is, and brought into view: a refusal below the fold reads as a press that did nothing.
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => { if (refusal || error) said.current?.scrollIntoView?.({ block: "nearest" }); }, [refusal, error]);
  const make = (repoPath?: string) => {
    setBusy(true); setError(null);
    run(async () => {
      try {
        const made = await makeTeam(spaceId, picked.templates, { roles: picked.customs, ...(repoPath ? { repoPath } : {}), ...(picked.raised !== null ? { weekBudgetUsd: picked.raised } : {}) });
        setRefusal(null);
        setSpacePageTab(spaceId, "team");
        if (made.repoMoved && made.repoPath && !repoPath) {
          toast({ tone: "info", icon: "folder", text: `The team's memory is in ${made.repoPath}: Realm's own folder is inside one of your projects, and memory stays apart from them.`, life: 12_000 });
        }
      } catch (e) {
        if (e instanceof RpcError && e.code === "MEMORY_REPO_FORBIDDEN") setRefusal(e.message);
        else setError(e instanceof Error ? e.message : String(e));
      } finally { setBusy(false); }
    });
  };
  const choose = () => run(async () => { const path = await pickFolder(); if (path) make(path); });
  const n = count(picked);
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>Team</h1></div>
        <span className="page-vantage">{space?.name}</span>
      </header>
      <div className="form">
        <p className="tp-lede">
          A team is this space with standing teammates: agents with a brief, a model, a clock and a budget, whose work comes to
          Review for your yes before anything leaves Realm. Choose who is on it — you can add, change or remove anyone later.
        </p>
        <Gallery team={team} picked={picked} setPicked={setPicked} onWrite={setWriting} />
        <div ref={said} className="tp-said">
          {refusal && (
            <div className="tp-refusal" role="alert">
              <Icon name="folder" size={16} />
              <div className="tp-refusal-text">
                <span className="settings-row-name">The team's memory needs a folder of its own</span>
                <span className="settings-row-detail">{refusal}</span>
              </div>
              <button type="button" className="btn" disabled={busy} onClick={choose}>Choose a folder…</button>
            </div>
          )}
          <SharesFoot team={team} picked={picked} setPicked={setPicked}>
            {error && <span className="tp-sheet-error" role="alert">{error}</span>}
            <button type="button" className="btn primary" disabled={busy || n === 0 || over} onClick={() => make()}
              title={n === 0 ? "Choose at least one teammate" : over ? "The shares are over the team's week" : undefined}>
              Make {space?.name ?? "this space"} a team
            </button>
          </SharesFoot>
        </div>
        {n === 0 && <p className="tp-make-note tp-picker-hint">Choose at least one teammate. Each runs on Sonnet unless you say otherwise, and stops at $3 or 20 minutes a run.</p>}
      </div>
      {writing !== false && (
        <DraftSheet spaceId={spaceId} team={team} picked={picked} index={writing}
          onSave={(r) => { setPicked((p) => ({ ...p, customs: writing === null ? [...p.customs, r] : p.customs.map((x, i) => (i === writing ? r : x)) })); setWriting(false); }}
          onClose={() => setWriting(false)} />
      )}
    </>
  );
}

/* ═══════════════════════════════ adding to one ═══════════════════════════════ */

/**
 * Add teammate: the same gallery as a sheet, with the starters already on the team lit and named so.
 * Writing a teammate replaces this sheet with the role sheet and comes back to it — one sheet at a
 * time, so Escape always means the one in front. One teammate added lands on its page.
 */
export function AddTeammatesSheet({ spaceId }: { spaceId: string }) {
  const team = useApp((s) => s.teams[spaceId]);
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const makeTeam = useApp((s) => s.makeTeam);
  const closeSheet = useApp((s) => s.closeSheet);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const run = useApp((s) => s.run);
  const [picked, setPicked] = useState<Picked>({ templates: [], customs: [], raised: null });
  const [writing, setWriting] = useState<number | null | false>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = count(picked);
  const t = totals(team, picked);
  const over = sharesNote(t.shares, t.cap).over;
  if (writing !== false) {
    return (
      <DraftSheet spaceId={spaceId} team={team} picked={picked} index={writing}
        onSave={(r) => { setPicked((p) => ({ ...p, customs: writing === null ? [...p.customs, r] : p.customs.map((x, i) => (i === writing ? r : x)) })); setWriting(false); }}
        onClose={() => setWriting(false)} />
    );
  }
  const add = () => {
    setBusy(true); setError(null);
    const before = new Set((team?.roles ?? []).map((r) => r.id));
    run(async () => {
      try {
        const made = await makeTeam(spaceId, picked.templates, { roles: picked.customs, ...(picked.raised !== null ? { weekBudgetUsd: picked.raised } : {}) });
        closeSheet();
        const added = made.roles.filter((r) => !before.has(r.id));
        openSpacePage(spaceId, added.length === 1 ? `role:${added[0]!.id}` : "team");
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    });
  };
  return (
    <Sheet title={`Add to the ${space?.name ?? "space"} team`} onClose={closeSheet} width={820}
      footer={
        <SharesFoot team={team} picked={picked} setPicked={setPicked}>
          {error && <span className="tp-sheet-error" role="alert">{error}</span>}
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || n === 0 || over} onClick={add}>
            {n === 0 ? "Add teammates" : `Add ${teammates(n)}`}
          </button>
        </SharesFoot>
      }>
      <div className="form tp-picker">
        <Gallery team={team} picked={picked} setPicked={setPicked} onWrite={setWriting} />
      </div>
    </Sheet>
  );
}

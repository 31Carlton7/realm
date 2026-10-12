import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { EVERY_OWNER, PR_SECTIONS, hasSearchQualifiers, prKey, prName, type PrOwners, type PrPage, type PrRef, type PrSection, type PrSummary } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useDissolve } from "../../components/ScrollFades";
import { useApp } from "../../state/store";
import {
  SECTION_LABEL, age, appendPage, emptyLine, namedOwners, narrowing, noMatchLine, ownerTicked, ownersLine, pressOthers, pressOwner, readQuery, sameLogin, sameRef, stillListed,
  type OwnersLine,
} from "./code-review-model";
import { codeReview } from "./code-review-api";
import { holdOwners, holdRefused, listsHeldUnder, listsMovedTo, pageHeld, type Listed } from "./held";

const LOADING: Listed = { prs: [], next: null, state: "loading", error: null };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Every row the three lists hold, as they are loaded. */
const rowsOf = (listed: Partial<Record<PrSection, Listed>>): PrSummary[] => PR_SECTIONS.flatMap((s) => listed[s]?.prs ?? []);

/**
 * The page's own column, Codex's: its name and menu, a search that also takes a pasted link, and the
 * three lists — what I opened, what is asked of me, what is asked of a team I am in — each a page at
 * a time with Show more. The team's list is folded until opened, as Codex keeps it: it is the one a
 * person reads least, and its request is only made when it is.
 *
 * It wears the sidebar's row anatomy, as the Scheduled page's column does: rows 8px in, the active
 * fill once chosen, nothing lit under a passing pointer.
 *
 * Its head says whose requests these are, beside its name: the account they are read and reviewed
 * as, and before it the profile where there is more than one and the row has room for both. The
 * column stands in the sidebar's place, and its name where the profile's would be. One sentence says
 * both to a screen reader and on hover, since the row itself has room for a name and a login at most.
 *
 * Its menu is where the account is, as Settings is: who gh is signed in as, and — where gh is signed
 * in to more than one — each of them to pick from, the one this profile reads, posts and ships as
 * ticked. A pick is kept for the profile, so the ticked account can be picked too while it is only
 * gh's active one: that keeps the profile on it when a terminal switches gh to another. With one
 * account there is nothing to choose, and the menu names it as it always did.
 *
 * The menu is also where the profile says whose requests its lists hold, by the owner of the
 * repository each is in. It has a ticked row for every owner its choice or its lists name, then
 * "Other owners" for all the rest. A press stores the choice, and then the lists on screen are read
 * again under it, and a search of plain words with them. The server reads the stored choice for
 * itself on every read, so the column says only whose choice to read under. While the choice leaves
 * anything out, one line over the lists says what, and a list's empty line keeps to the owners that
 * are listed. Where it lists no owner at all, an empty list says nothing, since that line says why.
 * Over the results of a search of plain words the line says only what is true of those results.
 * Another window's change to the same profile's choice is taken the same way, and the choice is
 * asked for again when the server is back after a break, since a change made meanwhile went
 * unheard. A change heard to another profile's choice is held for that profile's own column.
 *
 * A read asked for before a change of choice was heard is not drawn when it answers, since it may
 * have been made under the choice from before, and each list keeps the rows the new choice still
 * lists until it has been read again. A press made while an earlier one is still being stored builds
 * on that one, so a press changes its own row and no other.
 *
 * An update can leave a window on a server from before there was a choice, which has no call to
 * read one. Its refusal is held for the profile (`holdRefused`), and the column is drawn as that
 * server lists, which is every owner: each empty list says what it always said, the lists held are
 * drawn in the first frame, and the menu offers no owners, since no press could be stored. A read
 * of the choice that failed on its way is not a refusal, and is asked again once the server is back.
 */
export function PrColumn({ login, account, accounts, profile, profileId, pins, selected, onSelect, onAccount, onRefresh, onSignIn, onLost }: {
  login: string | null;
  /** What the lists and searches are sent as: the profile's pick, or null for gh's own account. */
  account: string | null;
  /** The accounts gh is signed in to, by login. */
  accounts: readonly string[];
  /** The profile's name, where there is another profile to tell it from; null where there is one. */
  profile: string | null;
  /** The profile whose choice of owners the lists and searches are read under. */
  profileId: string;
  pins: PrSummary[];
  selected: PrRef | null;
  onSelect: (pr: PrRef, row: PrSummary | null) => void;
  onAccount: (login: string) => void;
  /** Refresh was chosen: the lists are read again here, and whatever else the page keeps with them. */
  onRefresh: () => void;
  onSignIn: () => void;
  /** gh answered that it is gone or signed out: the page goes back to setup rather than drawing
   *  three lists that each say so. */
  onLost: () => void;
}) {
  const run = useApp((s) => s.run);
  const connected = useApp((s) => s.connectionState === "connected");
  const [owners, setOwners] = useState<PrOwners | null>(() => pageHeld.owners[profileId] ?? null);
  const [refused, setRefused] = useState(() => pageHeld.ownersRefused[profileId] === true);
  const under = owners ?? (refused ? EVERY_OWNER : null);
  /* The lists as they were last drawn, so coming back to the page shows them at once rather than
     three empty headings; each is read again behind them, from the server's cache. */
  const [lists, setLists] = useState<Partial<Record<PrSection, Listed>>>(() => ({ ...listsHeldUnder(under) }));
  const held = pageHeld.lists;
  const [teamOpen, setTeamOpen] = useState(pageHeld.teamOpen);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(Listed & { query: string }) | null>(null);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useDissolve(body);
  const here = useRef(true);
  const ahead = useRef<PrOwners | null>(null);
  const changes = useRef(0);
  const [again, setAgain] = useState(0);

  const take = useCallback((next: PrOwners) => {
    holdOwners(profileId, next);
    if (!here.current) return;
    setOwners(next);
    const moved = listsMovedTo(next);
    if (!moved) return;
    changes.current += 1;
    setLists(moved);
    setResults((cur) => (cur && !hasSearchQualifiers(cur.query) ? { ...cur, prs: stillListed(next, cur.prs), next: null, state: "loading", error: null } : cur));
    setAgain(changes.current);
  }, [profileId]);
  const refuse = useCallback((e: unknown) => {
    if ((e as { code?: unknown } | null)?.code !== "METHOD_NOT_FOUND") return;
    if (holdRefused(profileId, here.current) && here.current) setRefused(true);
  }, [profileId]);
  const ask = useCallback(() => { codeReview.owners(profileId).then(take, refuse); }, [profileId, take, refuse]);
  const choose = (change: (from: PrOwners) => PrOwners) => run(async () => {
    const from = ahead.current ?? pageHeld.owners[profileId];
    if (!from) return;
    const next = change(from);
    ahead.current = next;
    try { take(await codeReview.setOwners(profileId, next)); }
    finally { if (ahead.current === next) ahead.current = null; }
  });
  useEffect(() => { here.current = true; return () => { here.current = false; }; }, []);
  useEffect(() => { if (connected) ask(); }, [connected, ask]);
  useEffect(() => codeReview.onOwners((p) => { if (p.profileId === profileId) take(p.owners); else holdOwners(p.profileId, p.owners); }), [profileId, take]);

  const put = (section: PrSection, next: Listed) => {
    held[section] = next;
    setLists((cur) => ({ ...cur, [section]: next }));
  };
  const load = (section: PrSection, force = false) => {
    const cur = held[section];
    if (!cur || force) put(section, { ...(cur ?? LOADING), state: cur && !force ? cur.state : "loading" });
    const asked = changes.current;
    codeReview.list(section, null, force, account, profileId).then(
      (page) => { if (asked === changes.current) put(section, { prs: page.prs, next: page.nextCursor, state: "ready", error: null }); },
      (e: unknown) => {
        if (asked !== changes.current) return;
        put(section, { ...LOADING, state: "error", error: message(e) });
        const code = (e as { code?: unknown } | null)?.code;
        if (code === "GH_SIGNED_OUT" || code === "GH_MISSING") onLost();
      },
    );
  };
  const showMore = (section: PrSection) => {
    const cur = held[section]; if (!cur?.next) return;
    const asked = changes.current;
    codeReview.list(section, cur.next, false, account, profileId).then(
      (page) => { if (asked === changes.current) put(section, { prs: appendPage(cur.prs, page), next: page.nextCursor, state: "ready", error: null }); },
      (e: unknown) => run(() => Promise.reject(e)),
    );
  };

  useEffect(() => {
    load("authored"); load("review");
    if (pageHeld.teamOpen) load("team");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount; Refresh asks again
  }, []);
  useEffect(() => {
    if (again === 0) return;
    for (const s of PR_SECTIONS) if (held[s]) load(s);
  }, [again]);

  // Words search a beat after typing stops; an address is not a search at all.
  const q = readQuery(query);
  const narrows = q.kind === "search" && !hasSearchQualifiers(q.query);
  const stands = (words: string, asked: number) => hasSearchQualifiers(words) || asked === changes.current;
  useEffect(() => {
    if (q.kind !== "search") { setResults(null); return; }
    const words = q.query;
    setResults((cur) => (cur?.query === words ? cur : { ...LOADING, query: words }));
    const t = setTimeout(() => {
      const asked = changes.current;
      codeReview.search(words, null, account, profileId).then(
        (page: PrPage) => setResults((cur) => (cur?.query === words && stands(words, asked) ? { prs: page.prs, next: page.nextCursor, state: "ready", error: null, query: words } : cur)),
        (e: unknown) => setResults((cur) => (cur?.query === words && stands(words, asked) ? { ...LOADING, state: "error", error: message(e), query: words } : cur)),
      );
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what was typed, and for plain words by the choice of owners they are searched under
  }, [q.kind === "search" ? q.query : q.kind, narrows ? again : 0]);
  const moreResults = () => {
    const cur = results; if (!cur?.next) return;
    const asked = changes.current;
    codeReview.search(cur.query, cur.next, account, profileId).then(
      (page) => setResults((r) => (r?.query === cur.query && stands(cur.query, asked) ? { ...r, prs: appendPage(r.prs, page), next: page.nextCursor } : r)),
      (e: unknown) => run(() => Promise.reject(e)),
    );
  };

  const refresh = () => {
    onRefresh();
    ask();
    for (const s of PR_SECTIONS) if (held[s]) load(s, true);
  };
  const named = owners ? namedOwners(owners, rowsOf(lists)) : [];
  const whoseRequests: MenuItem[] = owners && (named.length > 0 || !owners.others)
    ? [
      { kind: "separator" },
      { kind: "header", label: "Owners" },
      ...named.map((o): MenuItem => {
        const ticked = ownerTicked(owners, o);
        return {
          label: o, checked: ticked, onSelect: () => choose((from) => pressOwner(from, o)),
          title: ticked ? `In this profile, stop listing pull requests in repositories owned by ${o}.`
            : `In this profile, list pull requests in repositories owned by ${o}.`,
        };
      }),
      {
        label: "Other owners", checked: owners.others, onSelect: () => choose((from) => pressOthers(from, namedOwners(from, rowsOf(pageHeld.lists)))),
        title: owners.others ? "In this profile, list pull requests only for the owners selected here. That leaves out every other owner, including any you start working with later."
          : "In this profile, list pull requests for every owner except the ones not selected here, including any you start working with later.",
      },
    ]
    : [];
  const who: MenuItem[] = accounts.length > 1
    ? [
      { kind: "header", label: "GitHub account" },
      ...accounts.map((a): MenuItem => {
        const inUse = sameLogin(a, login);
        const picked = sameLogin(a, account);
        return {
          label: `@${a}`, checked: inUse, onSelect: () => { if (!picked) onAccount(a); },
          title: picked ? `This profile reads pull requests, posts reviews, and opens pull requests as @${a}.`
            : inUse ? `This profile reads pull requests, posts reviews, and opens pull requests as @${a}, the account gh has active. To keep this profile on @${a} when that changes, choose it.`
              : `Read pull requests, post reviews, and open pull requests as @${a} in this profile. The account gh uses in a terminal stays the same.`,
        };
      }),
    ]
    : [{ kind: "header", label: login ? `Signed in to GitHub as @${login}` : "GitHub" }];
  const items: MenuItem[] = [
    { label: "Refresh", icon: <Icon name="reload" size={14} />, onSelect: refresh },
    { kind: "separator" },
    ...who,
    { label: "Sign in again in a terminal…", icon: <Icon name="terminal" size={14} />, onSelect: onSignIn,
      detail: "Opens a terminal with gh auth login typed in" },
    ...whoseRequests,
  ];

  const whose = !login ? null : profile ? `Code review in the ${profile} profile reads and posts as @${login}.` : `Code review reads and posts as @${login}.`;
  const says = (line: OwnersLine | null) => line && (
    <p className="cr-col-note cr-col-owners" title={line.tip}>
      <span className="visually-hidden">{line.sentence}</span>
      <span className="cr-col-owners-how" aria-hidden="true">{line.how}</span>
      {line.who && <span className="cr-col-owners-who" aria-hidden="true">{line.who}</span>}
    </p>
  );
  const narrowed = under && narrowing(under);
  const asTyped = results !== null && hasSearchQualifiers(results.query);

  const toggleTeam = () => {
    pageHeld.teamOpen = !teamOpen;
    setTeamOpen(!teamOpen);
    if (!teamOpen && !held.team) load("team");
  };

  return (
    <nav className="cr-col" aria-label="Pull requests">
      <div className="cr-col-head">
        <h1 className="cr-col-title">Code review</h1>
        <span className="cr-col-as" title={whose ?? undefined}>
          {whose && <span className="visually-hidden">{whose}</span>}
          {login && profile && <span className="cr-col-as-profile" aria-hidden="true"><span>{profile}</span><span>·</span></span>}
          {login && <span className="cr-col-as-login" aria-hidden="true">@{login}</span>}
        </span>
        <button ref={more} type="button" className="icon-btn" aria-label="Code review options" title="More" aria-haspopup="menu" aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}><Icon name="more" size={14} /></button>
        {menu && <Menu items={items} anchorRef={more} align="right" label="Code review options" onClose={() => setMenu(false)} />}
      </div>
      <div className="cr-col-search">
        <Icon name="search" size={14} className="cr-col-search-mark" />
        <input className="search-field" type="search" aria-label="Search or paste a pull request link" placeholder="Search or paste a PR link"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); }
            if (e.key === "Enter" && q.kind === "ref") onSelect(q.ref, null);
          }} />
      </div>
      <div ref={body} className="cr-col-body">
        {q.kind === "ref" ? (
          <ul className="cr-rows">
            <li>
              <button type="button" className="cr-row cr-row-open" data-active={sameRef(selected, q.ref) || undefined} onClick={() => onSelect(q.ref, null)}>
                <span className="cr-row-title"><Icon name="pullRequest" size={14} /> Open {prName(q.ref)}</span>
              </button>
            </li>
          </ul>
        ) : results ? (
          <>
            {!asTyped && owners && says(ownersLine(owners, true))}
            <Section label="Results" listed={results} selected={selected} onSelect={onSelect} onMore={moreResults}
              empty={noMatchLine(results.query, asTyped ? false : narrowed)} />
          </>
        ) : (
          <>
            {pins.length > 0 && (
              <Section label="Pinned" listed={{ prs: pins, next: null, state: "ready", error: null }} selected={selected} onSelect={onSelect} />
            )}
            {owners && says(ownersLine(owners))}
            <Section label={SECTION_LABEL.authored} listed={lists.authored ?? LOADING} selected={selected} onSelect={onSelect}
              onMore={() => showMore("authored")} onRetry={() => load("authored", true)} empty={emptyLine("authored", narrowed)} />
            <Section label={SECTION_LABEL.review} listed={lists.review ?? LOADING} selected={selected} onSelect={onSelect}
              onMore={() => showMore("review")} onRetry={() => load("review", true)} empty={emptyLine("review", narrowed)} />
            <button type="button" className="cr-section-toggle" aria-expanded={teamOpen} onClick={toggleTeam}>
              {SECTION_LABEL.team}<Icon name="chevronRight" size={12} />
            </button>
            {teamOpen && (
              <Section label={null} listed={lists.team ?? LOADING} selected={selected} onSelect={onSelect}
                onMore={() => showMore("team")} onRetry={() => load("team", true)} empty={emptyLine("team", narrowed)} />
            )}
          </>
        )}
      </div>
    </nav>
  );
}

/**
 * The column before gh has answered, the first time the page opens in a window: its head and its
 * search as the column draws them, and nothing listed yet. It stands in the sidebar's place from the
 * page's first frame, so the lists arrive under a column already there. Whose requests they are is
 * said once gh has said who is signed in; the place for it is kept, so the ⋯ stands where it will.
 */
export function PrColumnPending() {
  return (
    // A picture of the column for the moment before gh answers: nothing in it works yet, so nothing
    // in it is offered — to the pointer, the keyboard or a screen reader.
    <div className="cr-col" aria-hidden="true" inert>
      <div className="cr-col-head">
        <span className="cr-col-title">Code review</span>
        <span className="cr-col-as" />
        <span className="icon-btn"><Icon name="more" size={14} /></span>
      </div>
      <div className="cr-col-search">
        <Icon name="search" size={14} className="cr-col-search-mark" />
        <input className="search-field" type="search" placeholder="Search or paste a PR link" tabIndex={-1} readOnly />
      </div>
    </div>
  );
}

/** One list: its heading, its rows, and what to say when there are none, or none could be read. */
function Section({ label, listed, selected, onSelect, onMore, onRetry, empty }: {
  label: string | null; listed: Listed; selected: PrRef | null;
  onSelect: (pr: PrRef, row: PrSummary) => void; onMore?: () => void; onRetry?: () => void; empty?: string;
}) {
  return (
    <section className="cr-section" aria-label={label ?? undefined}>
      {label && <h2 className="group-label cr-section-label">{label}</h2>}
      {listed.state === "error" ? (
        <p className="cr-col-note" data-tone="bad">
          Could not load these: {listed.error}{onRetry && <> <button type="button" className="cr-col-link" onClick={onRetry}>Try again</button></>}
        </p>
      ) : listed.state === "loading" && listed.prs.length === 0 ? (
        <p className="cr-col-note">Loading…</p>
      ) : listed.prs.length === 0 ? (
        empty ? <p className="cr-col-note">{empty}</p> : null
      ) : (
        <ul className="cr-rows">
          {listed.prs.map((pr) => <PrRow key={prKey(pr.ref)} pr={pr} active={sameRef(selected, pr.ref)} onSelect={() => onSelect(pr.ref, pr)} />)}
        </ul>
      )}
      {listed.next && onMore && <button type="button" className="cr-col-link cr-more" onClick={onMore}>Show more</button>}
    </section>
  );
}

/** A request as a row: its title, then who opened it, how long ago it moved, and where it lives —
 *  the repository yielding first, since the title and the person are what a row is chosen by. */
function PrRow({ pr, active, onSelect }: { pr: PrSummary; active: boolean; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className="cr-row" data-active={active || undefined} aria-current={active ? "true" : undefined}
        title={`${prName(pr.ref)} — ${pr.title}`} onClick={onSelect}>
        <span className="cr-row-title">{pr.title}</span>
        <span className="cr-row-meta">
          <Monogram name={pr.author} />
          <span className="cr-row-who">{pr.author ?? "ghost"}</span>
          <span aria-hidden="true">·</span>
          <span className="cr-row-age">{age(pr.updatedAt)}</span>
          {pr.draft && <><span aria-hidden="true">·</span><span>Draft</span></>}
          <span aria-hidden="true">·</span>
          <span className="cr-row-repo">{pr.ref.repo} #{pr.ref.number}</span>
        </span>
      </button>
    </li>
  );
}

/** A person by their initial, on the neutral ladder. GitHub's pictures are not fetched: the window
 *  loads no image from the network, and a stranger's picture is not worth the exception. */
export function Monogram({ name, size = 16 }: { name: string | null; size?: 16 | 20 }) {
  return <span className="cr-monogram" data-size={size} aria-hidden="true">{(name ?? "?").replace(/^\[bot\]|[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?"}</span>;
}

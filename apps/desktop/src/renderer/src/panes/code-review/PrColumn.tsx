import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { PR_SECTIONS, prKey, prName, type PrPage, type PrRef, type PrSection, type PrSummary } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useDissolve } from "../../components/ScrollFades";
import { useApp } from "../../state/store";
import { SECTION_LABEL, age, appendPage, readQuery, sameLogin, sameRef } from "./code-review-model";
import { codeReview } from "./code-review-api";
import { pageHeld, type Listed } from "./held";

const LOADING: Listed = { prs: [], next: null, state: "loading", error: null };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The page's own column, Codex's: its name and menu, a search that also takes a pasted link, and the
 * three lists — what I opened, what is asked of me, what is asked of a team I am in — each a page at
 * a time with Show more. The team's list is folded until opened, as Codex keeps it: it is the one a
 * person reads least, and its request is only made when it is.
 *
 * It wears the sidebar's row anatomy, as the Scheduled page's column does: rows 8px in, the active
 * fill once chosen, nothing lit under a passing pointer.
 *
 * Its menu is where the account is: who gh is signed in as, and — where gh is signed in to more than
 * one — each of them to pick from, the one this profile reads and posts as ticked. A pick is kept for
 * the profile, so the ticked account can be picked too while it is only gh's active one: that keeps
 * the profile on it when a terminal switches gh to another. With one account there is nothing to
 * choose, and the menu names it as it always did.
 */
export function PrColumn({ login, account, accounts, pins, selected, onSelect, onAccount, onRefresh, onSignIn, onLost }: {
  login: string | null;
  /** What the lists and searches are sent as: the profile's pick, or null for gh's own account. */
  account: string | null;
  /** The accounts gh is signed in to, by login. */
  accounts: readonly string[];
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
  /* The lists as they were last drawn, so coming back to the page shows them at once rather than
     three empty headings; each is read again behind them, from the server's cache. */
  const held = pageHeld.lists;
  const [lists, setLists] = useState<Partial<Record<PrSection, Listed>>>(() => ({ ...held }));
  const [teamOpen, setTeamOpen] = useState(pageHeld.teamOpen);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(Listed & { query: string }) | null>(null);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useDissolve(body);

  const put = (section: PrSection, next: Listed) => {
    held[section] = next;
    setLists((cur) => ({ ...cur, [section]: next }));
  };
  const load = (section: PrSection, force = false) => {
    const cur = held[section];
    if (!cur || force) put(section, { ...(cur ?? LOADING), state: cur && !force ? cur.state : "loading" });
    codeReview.list(section, null, force, account).then(
      (page) => put(section, { prs: page.prs, next: page.nextCursor, state: "ready", error: null }),
      (e: unknown) => {
        put(section, { ...LOADING, state: "error", error: message(e) });
        const code = (e as { code?: unknown } | null)?.code;
        if (code === "GH_SIGNED_OUT" || code === "GH_MISSING") onLost();
      },
    );
  };
  const showMore = (section: PrSection) => {
    const cur = held[section]; if (!cur?.next) return;
    codeReview.list(section, cur.next, false, account).then(
      (page) => put(section, { prs: appendPage(cur.prs, page), next: page.nextCursor, state: "ready", error: null }),
      (e: unknown) => run(() => Promise.reject(e)),
    );
  };

  useEffect(() => {
    load("authored"); load("review");
    if (pageHeld.teamOpen) load("team");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount; Refresh asks again
  }, []);

  // Words search a beat after typing stops; an address is not a search at all.
  const q = readQuery(query);
  useEffect(() => {
    if (q.kind !== "search") { setResults(null); return; }
    const words = q.query;
    setResults((cur) => (cur?.query === words ? cur : { ...LOADING, query: words }));
    const t = setTimeout(() => {
      codeReview.search(words, null, account).then(
        (page: PrPage) => setResults((cur) => (cur?.query === words ? { prs: page.prs, next: page.nextCursor, state: "ready", error: null, query: words } : cur)),
        (e: unknown) => setResults((cur) => (cur?.query === words ? { ...LOADING, state: "error", error: message(e), query: words } : cur)),
      );
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what was typed
  }, [q.kind === "search" ? q.query : q.kind]);
  const moreResults = () => {
    const cur = results; if (!cur?.next) return;
    codeReview.search(cur.query, cur.next, account).then(
      (page) => setResults((r) => (r?.query === cur.query ? { ...r, prs: appendPage(r.prs, page), next: page.nextCursor } : r)),
      (e: unknown) => run(() => Promise.reject(e)),
    );
  };

  const refresh = () => {
    onRefresh();
    for (const s of PR_SECTIONS) if (held[s]) load(s, true);
  };
  const who: MenuItem[] = accounts.length > 1
    ? [
      { kind: "header", label: "GitHub account" },
      ...accounts.map((a): MenuItem => {
        const inUse = sameLogin(a, login);
        const picked = sameLogin(a, account);
        return {
          label: `@${a}`, checked: inUse, onSelect: () => { if (!picked) onAccount(a); },
          title: picked ? `Code review in this profile reads and posts as @${a}.`
            : inUse ? `Code review in this profile reads and posts as @${a}, the account gh has active. To keep this profile on @${a} when that changes, choose it.`
              : `Read pull requests and post reviews as @${a} in this profile. The account gh uses in a terminal stays the same.`,
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
  ];

  const toggleTeam = () => {
    pageHeld.teamOpen = !teamOpen;
    setTeamOpen(!teamOpen);
    if (!teamOpen && !held.team) load("team");
  };

  return (
    <nav className="cr-col" aria-label="Pull requests">
      <div className="cr-col-head">
        <h1 className="cr-col-title">Code review</h1>
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
          <Section label="Results" listed={results} selected={selected} onSelect={onSelect} onMore={moreResults}
            empty={`No pull request you are part of matches “${results.query}”.`} />
        ) : (
          <>
            {pins.length > 0 && (
              <Section label="Pinned" listed={{ prs: pins, next: null, state: "ready", error: null }} selected={selected} onSelect={onSelect} />
            )}
            <Section label={SECTION_LABEL.authored} listed={lists.authored ?? LOADING} selected={selected} onSelect={onSelect}
              onMore={() => showMore("authored")} onRetry={() => load("authored", true)} empty="Nothing of yours is open." />
            <Section label={SECTION_LABEL.review} listed={lists.review ?? LOADING} selected={selected} onSelect={onSelect}
              onMore={() => showMore("review")} onRetry={() => load("review", true)} empty="Nobody is waiting on your review." />
            <button type="button" className="cr-section-toggle" aria-expanded={teamOpen} onClick={toggleTeam}>
              {SECTION_LABEL.team}<Icon name="chevronRight" size={12} />
            </button>
            {teamOpen && (
              <Section label={null} listed={lists.team ?? LOADING} selected={selected} onSelect={onSelect}
                onMore={() => showMore("team")} onRetry={() => load("team", true)} empty="No team of yours is waiting on a review." />
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
 * page's first frame, so the lists arrive under a column already there.
 */
export function PrColumnPending() {
  return (
    // A picture of the column for the moment before gh answers: nothing in it works yet, so nothing
    // in it is offered — to the pointer, the keyboard or a screen reader.
    <div className="cr-col" aria-hidden="true" inert>
      <div className="cr-col-head">
        <span className="cr-col-title">Code review</span>
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

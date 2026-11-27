import { AGENT_SIGNINS_CARD, AGENT_SIGNINS_OFFER, type Asker } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAppStoreMaybe, type PermissionDecision } from "../../state/store";
import { turnOnSignins } from "../../state/turn-on-signins";
import type { PendingPermission } from "./transcript-model";
import { clip, prettyJson, toolIcon, toolSummary } from "./tool-summary";
import { ToolInputBody } from "./rich/ToolViews";
import { useDissolve } from "../../components/ScrollFades";
import { toolInputView } from "./rich/tool-view";
import { askerIcon, askerLine } from "./QuestionCard";

/** §5's numbered-list pattern (`HJz3KMT`): the options are a list with kbd number chips, the
 *  selected row is an --rl-active pill, and the footer carries the navigation hints on the left and
 *  the accent Submit pill on the right. Order is deliberate — Allow is first, so it is what the
 *  default selection and a bare Enter mean. */
type Option = {
  decision: PermissionDecision; label: string; kbd: string;
  /** Turn on agent sign-ins in Settings' own IPC first, then answer `decision`. */
  turnsOnSignins?: true;
  /** Open Settings ▸ Sign-ins as well as answering. */
  opensSignins?: true;
};

const OPTIONS: Option[] = [
  { decision: "allow", label: "Allow", kbd: "↵" },
  { decision: "allow_always", label: "Allow always", kbd: "⇧↵" },
  { decision: "deny", label: "Deny", kbd: "⌘⌫" },
];

/**
 * What "always" is worth, for the tools where it is not the session.
 *
 * `computer_act`'s always is written to the space's allowed-apps list and outlives the session, so
 * the option has to say so — a user answering "Allow always" about an application on their own Mac
 * is owed the scope they are granting, and the plain label reads as "for now" next to "Allow". The
 * option list itself is unchanged: this is the same decision reaching a different store, not a
 * fourth answer, which would have to be understood by every adapter that can receive one.
 */
const ALWAYS_LABEL: Record<string, string> = { computer_act: "Always allow in this space" };

/** A password fill on a page of the password's own site (`page` on its input) keeps "always" for that
 *  password on that page, in Realm's store, and the card still unlocks by Touch ID — so it says where. */
const alwaysLabel = (toolName: string, input: unknown): string | undefined =>
  toolName === "browser_fill_credential" && typeof (input as { page?: unknown } | null)?.page === "string"
    ? "Always allow on this site"
    : ALWAYS_LABEL[toolName];

/** A code fill is approved one fill at a time and the server records no "always" for it, so the card
 *  does not offer one. */
const NO_ALWAYS = new Set(["browser_fill_code"]);

/** A password fill on its own site while agent sign-ins are off (`AGENT_SIGNINS_OFFER`): Turn on sign-ins
 *  stands where Always allow on this site would, and answers Allow once main's switch is on, so the
 *  fill goes ahead with no second card. */
const OFFER_OPTIONS: Option[] = [
  { decision: "allow", label: "Allow once", kbd: "↵" },
  { decision: "allow", label: "Turn on sign-ins", kbd: "⇧↵", turnsOnSignins: true },
  { decision: "deny", label: "Deny", kbd: "⌘⌫" },
];

/** The invitation to turn agent sign-ins on (`AGENT_SIGNINS_CARD`): nothing waits on it, so its
 *  answers only open Settings or put it away. */
const INVITE_OPTIONS: Option[] = [
  { decision: "allow", label: "Open Settings", kbd: "↵", opensSignins: true },
  { decision: "deny", label: "Not now", kbd: "⌘⌫" },
];

const optionsFor = (toolName: string, input?: unknown): Option[] => {
  if (toolName === AGENT_SIGNINS_CARD) return INVITE_OPTIONS;
  if (toolName === "browser_fill_credential" && (input as Record<string, unknown> | null)?.[AGENT_SIGNINS_OFFER] === true) return OFFER_OPTIONS;
  if (NO_ALWAYS.has(toolName)) return OPTIONS.filter((o) => o.decision !== "allow_always");
  const label = alwaysLabel(toolName, input);
  return label ? OPTIONS.map((o) => (o.decision === "allow_always" ? { ...o, label } : o)) : OPTIONS;
};

/** The agent wants to run a tool: Allow (once) / Allow always / Deny.
 *
 *  Keyboard (U-H4): with `autoFocus` (the card sits in the focused pane) the Allow option takes
 *  focus on mount, so a bare Enter answers the hottest question in the app. Inside the card:
 *  Enter = the selected option, ⇧Enter = the second option (Allow always, or Turn on sign-ins), ⌘⌫ =
 *  Deny, 1/2/3 pick an option outright,
 *  ↑/↓ move the selection, Esc denies. Buttons keep exact accessible names ("Allow", not "Allow 1")
 *  via aria-label; the number chips and footer hints are visual only. */
export function PermissionCard({ permission, asker, onDecide, autoFocus = false, enter = false, ownsEscape = true }: {
  permission: PendingPermission; onDecide: (d: PermissionDecision) => void; autoFocus?: boolean; enter?: boolean;
  /** Who is asking — the session's agent, or the teammate whose session it is — said first, as a
   *  question card says it. Absent where the surface cannot name one. */
  asker?: Asker;
  /** False where the surface around the card owns Escape (the need-you list), so Escape leaves it
   *  instead: the card then neither answers on Escape nor offers it as a key. */
  ownsEscape?: boolean;
}) {
  const line = clip(toolSummary(permission.toolName, permission.input), 200);
  /* A summary the title already says is the thing asked about said twice: a password fill's title
     names its site, and the site again beside the tool's name is a third reading of it. */
  const summary = line && !permission.title.includes(line) ? line : "";
  /* Plan 24 W1: the thing being approved, drawn. An Edit's diff, the command about to run, the host
     about to be fetched — shown OPEN, because "Allow" on a change nobody has seen is not consent.
     The raw payload stays under the details below it: the drawing is what the reader decides on,
     the JSON is what they check when the drawing surprises them. */
  const preview = toolInputView(permission.toolName, permission.input);
  const options = optionsFor(permission.toolName, permission.input);
  /** What ⇧↵ answers: Allow always, or Turn on sign-ins where it stands in that place. */
  const second = options.find((o) => o.decision === "allow_always" || o.turnsOnSignins);
  const store = useAppStoreMaybe();
  const [turning, setTurning] = useState(false);
  const [turnOnFailed, setTurnOnFailed] = useState(false);
  const choose = (o: Option) => {
    if (o.turnsOnSignins) {
      if (turning) return;
      setTurning(true);
      setTurnOnFailed(false);
      void turnOnSignins().then(
        ({ signins }) => { if (signins?.enabled === true) onDecide(o.decision); else setTurnOnFailed(true); },
        () => setTurnOnFailed(true),
      ).finally(() => setTurning(false));
      return;
    }
    if (o.opensSignins) store?.getState().openSettingsPage("signins");
    onDecide(o.decision);
  };
  const raw = useRef<HTMLPreElement>(null);
  useDissolve(raw);
  const [selected, setSelected] = useState(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { if (autoFocus) rows.current[0]?.focus(); }, [autoFocus]);

  /** Move the selection and take focus with it, so the focused control and the highlighted row are
   *  never two different answers to the same question. */
  const select = (i: number) => {
    const next = (i + options.length) % options.length;
    setSelected(next);
    rows.current[next]?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      // A focused control wins over the card's default: Enter on the Deny row must mean Deny,
      // never the card-level selection (security inversion). Buttons are activated explicitly (with
      // preventDefault, so the browser's own Enter→click never double-fires); Enter on the details
      // <summary> is left entirely to native toggle semantics and decides nothing.
      const control = e.target instanceof HTMLElement ? e.target.closest("button, summary") : null;
      // ⇧⏎ is Allow always's chord from anywhere on the card, as ⌘⌫ is Deny's. Allow has focus from
      // the moment the card appears, so a chord that deferred to the focused control never fired.
      if (e.shiftKey && second && !(control instanceof HTMLElement && control.tagName === "SUMMARY")) { e.preventDefault(); choose(second); return; }
      if (control instanceof HTMLButtonElement) { e.preventDefault(); control.click(); return; }
      if (control) return;
      e.preventDefault(); choose(options[selected]!);
    } else if (e.key === "Backspace" && e.metaKey) { e.preventDefault(); onDecide("deny"); }
    else if (e.key === "Escape" && ownsEscape) { e.preventDefault(); e.stopPropagation(); onDecide("deny"); }
    else if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
    // Bare digits only: ⌘1–9 is the app's switch-space binding, and a permission decision is the
    // last thing that may fire off a modifier chord it does not own.
    else if (e.key >= "1" && e.key <= String(options.length) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); choose(options[Number(e.key) - 1]!);
    }
  };

  return (
    /* data-no-agent: nothing inside this card may be acted on by `app_act`, in any mode. An agent
       able to press these buttons could approve the very request it is blocked on, and no permission
       model survives that — every approval in Realm ends up as a button in this window. The claim
       lives HERE, on the component that grants things, rather than as a label match in main, so
       whoever next changes this card sees it. `app-drive.ts` carries the reasoning. */
    <div className="permission-card" role="group" aria-label="Permission request" data-no-agent="permission request" data-enter={enter || undefined} onKeyDown={onKeyDown}>
      {/* Who is asking, then the question, then the thing asked about, each once. The tool row above
          the card already says "Waiting for you"; the dot is the card's only other mark of it. A
          drawn preview IS the command, so the one-line summary is only for a tool with no drawing. */}
      {asker && (
        <div className="question-from permission-from">
          <span className="permission-dot" />
          <Icon name={askerIcon(asker)} size={14} colored />
          <span className="question-from-name">{askerLine(asker)}</span>
        </div>
      )}
      <div className="permission-head">
        {!asker && <span className="permission-dot" />}
        <span>{permission.title}</span>
      </div>
      {preview
        ? <div className="permission-preview"><ToolInputBody view={preview} /></div>
        : <div className="permission-tool"><Icon name={toolIcon(permission.toolName)} size={16} /><span className="tool-name">{permission.toolName}</span>{summary && <code>{summary}</code>}</div>}
      <details className="permission-details"><summary>{preview ? "Raw input" : "Input"}</summary><pre ref={raw}>{prettyJson(permission.input)}</pre></details>
      <div className="permission-options">
        {options.map((o, i) => (
          <button key={o.label} ref={(el) => { rows.current[i] = el; }} className="permission-option"
            aria-label={o.label} data-selected={i === selected || undefined} data-decision={o.decision}
            disabled={o.turnsOnSignins && turning} onFocus={() => setSelected(i)} onClick={() => choose(o)}>
            <kbd className="permission-num">{i + 1}</kbd>
            <span className="permission-option-label">{o.label}</span>
            <kbd className="permission-option-kbd">{o.kbd}</kbd>
          </button>
        ))}
      </div>
      {turnOnFailed && <p className="question-note" role="alert">Realm couldn't turn on sign-ins. Nothing was filled.</p>}
      <div className="permission-footer">
        <div className="permission-hints">
          <span><kbd>↑↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span>{ownsEscape && <span><kbd>esc</kbd> Deny</span>}
        </div>
        <button className="btn primary permission-submit" aria-label="Submit" onClick={() => choose(options[selected]!)}>
          Submit <kbd>↵</kbd>
        </button>
      </div>
    </div>
  );
}

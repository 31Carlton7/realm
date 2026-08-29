import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon, Cancel01Icon, Folder01Icon, Briefcase01Icon, MortarboardIcon, Home01Icon, UserIcon,
  ComputerTerminal01Icon, GlobeIcon, SmartPhone01Icon, File01Icon, BrainIcon, LayoutGridIcon,
  Settings01Icon, MoreHorizontalIcon, ChatIcon, Search01Icon, PinIcon, PinOffIcon, ArrowLeft01Icon, ArrowRight01Icon,
  Tick01Icon, Delete02Icon, PencilEdit02Icon, Sun03Icon, Moon02Icon,
  SentIcon, StopIcon, SparklesIcon, ArrowDown01Icon, ArrowDown02Icon, ArrowUp02Icon, Loading03Icon, CheckmarkCircle02Icon, CancelCircleIcon,
  Alert02Icon, BotIcon, Wrench01Icon, CodeIcon, IdeaIcon, Copy01Icon,
  Task01Icon, GitBranchIcon, GitCompareIcon, GitCommitIcon, GitPullRequestIcon,
} from "@hugeicons-pro/core-stroke-standard";
import { brandMarks, isBrandName, type BrandName } from "./brand-icons";

export const icons = {
  add: Add01Icon, close: Cancel01Icon, folder: Folder01Icon, briefcase: Briefcase01Icon, cap: MortarboardIcon,
  home: Home01Icon, user: UserIcon, terminal: ComputerTerminal01Icon, browser: GlobeIcon, simulator: SmartPhone01Icon,
  artifact: File01Icon, context: BrainIcon, layout: LayoutGridIcon, settings: Settings01Icon, more: MoreHorizontalIcon,
  session: ChatIcon, search: Search01Icon, pin: PinIcon, unpin: PinOffIcon, chevronLeft: ArrowLeft01Icon, chevronRight: ArrowRight01Icon,
  check: Tick01Icon, trash: Delete02Icon, edit: PencilEdit02Icon, sun: Sun03Icon, moon: Moon02Icon,
  send: SentIcon, stop: StopIcon, sparkles: SparklesIcon, chevronDown: ArrowDown01Icon, arrowDown: ArrowDown02Icon, arrowUp: ArrowUp02Icon, spinner: Loading03Icon,
  checkCircle: CheckmarkCircle02Icon, errorCircle: CancelCircleIcon, alert: Alert02Icon, bot: BotIcon, tool: Wrench01Icon, code: CodeIcon, idea: IdeaIcon,
  copy: Copy01Icon, plan: Task01Icon, branch: GitBranchIcon, diff: GitCompareIcon, commit: GitCommitIcon, pullRequest: GitPullRequestIcon,
} as const;
/** Hugeicons names plus the vendored provider marks — one namespace, so callers (and `AGENT_META`)
 *  never have to know which pack a glyph came from. */
export type IconName = keyof typeof icons | BrandName;
export function isIconName(x: string): x is IconName {
  return Object.prototype.hasOwnProperty.call(icons, x) || isBrandName(x);
}

export function Icon({ name, size = 16, className }: { name: IconName | (string & {}); size?: number; className?: string }) {
  // Brand marks are filled 24×24 paths, not strokes, so they cannot ride HugeiconsIcon's stroke
  // rendering — but they stay inside this one component and this one name map (§7 allows the agent
  // glyph; everything else is still the Hugeicons stroke-standard set).
  if (isBrandName(name)) {
    const mark = brandMarks[name];
    return (
      // Decorative like the rest of the set: every mark sits beside text that already names the
      // agent, so announcing "Anthropic" again would only add noise. `data-brand` is the test and
      // CSS hook.
      <svg className={className} data-brand={name} width={size} height={size} viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d={mark.d} fill="currentColor" fillRule={"evenOdd" in mark ? "evenodd" : undefined} />
      </svg>
    );
  }
  const icon = Object.prototype.hasOwnProperty.call(icons, name) ? icons[name as keyof typeof icons] : icons.folder;
  // Design language §7: stroke weight stays the pack's 1.5px at every size.
  return <HugeiconsIcon icon={icon} size={size} className={className} strokeWidth={1.5} />;
}

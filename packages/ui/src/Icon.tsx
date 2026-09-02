import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon, Cancel01Icon, Folder01Icon, Briefcase01Icon, MortarboardIcon, Home01Icon, UserIcon,
  ComputerTerminal01Icon, GlobeIcon, SmartPhone01Icon, File01Icon, BrainIcon, LayoutGridIcon,
  Settings01Icon, MoreHorizontalIcon, ChatIcon, Search01Icon, PinIcon, PinOffIcon, ArrowLeft01Icon, ArrowRight01Icon,
  Tick01Icon, Delete02Icon, PencilEdit02Icon, Sun03Icon, Moon02Icon, RefreshIcon,
  SentIcon, StopIcon, SparklesIcon, ArrowDown01Icon, ArrowDown02Icon, ArrowUp02Icon, Loading03Icon, CheckmarkCircle02Icon, CancelCircleIcon,
  Alert02Icon, BotIcon, Wrench01Icon, CodeIcon, IdeaIcon, Copy01Icon, Attachment01Icon, Image01Icon,
  Task01Icon, GitBranchIcon, GitCompareIcon, GitCommitIcon, GitPullRequestIcon, LaptopIcon, PlugSocketIcon,
  Layout2ColumnIcon, Layout2RowIcon, BookOpen01Icon, Notification02Icon, Download04Icon,
  // Space icon picker's "Default" section (SPACE_ICONS, packages/contracts/src/presets.ts) — every
  // name there must have a matching key below.
  Rocket01Icon, StarIcon, Book01Icon, Camera01Icon, MusicNote01Icon, Shield01Icon, Flag01Icon, Coffee01Icon, Target01Icon, Compass01Icon,
  CrownIcon, Calendar01Icon, Clock01Icon, GameController01Icon, PaintBrush01Icon, MagicWand01Icon, Tree01Icon, Building01Icon, ZapIcon, DiamondIcon,
  FireIcon, Leaf01Icon, MountainIcon, FlowerIcon, RainbowIcon, UmbrellaIcon, CloudIcon, AnchorIcon, PuzzleIcon, GiftIcon,
  Award01Icon, BulbIcon, Key01Icon, LockIcon, Notification01Icon, Mic01Icon, HeadphonesIcon, Video01Icon, DiceIcon, Store01Icon,
  House01Icon, PlaneIcon, Train01Icon, BicycleIcon, Globe02Icon, PaintBucketIcon, Pen01Icon, RulerIcon, PenTool01Icon, StartUp01Icon,
  Bookmark01Icon, BookOpen02Icon, FavouriteIcon, HeartbreakIcon, CameraAiIcon, FireworksIcon, DiceFaces01Icon, GameboyIcon, PentagonIcon, MicroscopeIcon,
  Maximize01Icon, Minimize01Icon, LayoutTable01Icon, SidebarLeft01Icon, Archive02Icon, ArchiveArrowUpIcon,
} from "@hugeicons-pro/core-stroke-standard";
import { brandMarks, isBrandName, type BrandName } from "./brand-icons";

export const icons = {
  add: Add01Icon, close: Cancel01Icon, folder: Folder01Icon, briefcase: Briefcase01Icon, cap: MortarboardIcon,
  home: Home01Icon, user: UserIcon, terminal: ComputerTerminal01Icon, browser: GlobeIcon, simulator: SmartPhone01Icon,
  artifact: File01Icon, context: BrainIcon, layout: LayoutGridIcon, settings: Settings01Icon, more: MoreHorizontalIcon,
  sidebar: SidebarLeft01Icon,
  session: ChatIcon, search: Search01Icon, pin: PinIcon, unpin: PinOffIcon, chevronLeft: ArrowLeft01Icon, chevronRight: ArrowRight01Icon,
  check: Tick01Icon, trash: Delete02Icon, edit: PencilEdit02Icon, sun: Sun03Icon, moon: Moon02Icon,
  send: SentIcon, stop: StopIcon, sparkles: SparklesIcon, chevronDown: ArrowDown01Icon, arrowDown: ArrowDown02Icon, arrowUp: ArrowUp02Icon, spinner: Loading03Icon,
  checkCircle: CheckmarkCircle02Icon, errorCircle: CancelCircleIcon, alert: Alert02Icon, bot: BotIcon, tool: Wrench01Icon, code: CodeIcon, idea: IdeaIcon,
  copy: Copy01Icon, plan: Task01Icon, attach: Attachment01Icon, image: Image01Icon, reload: RefreshIcon,
  branch: GitBranchIcon, diff: GitCompareIcon, commit: GitCommitIcon, pullRequest: GitPullRequestIcon,
  splitRight: Layout2ColumnIcon, splitDown: Layout2RowIcon,
  // Pane focus (zoom one pane to the whole host) and its inverse; `group` is a pane group's tab.
  focusPane: Maximize01Icon, unfocusPane: Minimize01Icon, group: LayoutTable01Icon,
  laptop: LaptopIcon, plug: PlugSocketIcon, download: Download04Icon,
  // Shelve a sidebar row / take it back off the shelf. The pair is directional on purpose — the same
  // box, with the restore glyph lifting out of it — so the hover button reads as a toggle.
  archive: Archive02Icon, unarchive: ArchiveArrowUpIcon,
  // Space icon picker's "Default" section — one entry per SPACE_ICONS name (packages/contracts/src/presets.ts).
  rocket: Rocket01Icon, star: StarIcon, book: Book01Icon, camera: Camera01Icon, musicNote: MusicNote01Icon,
  shield: Shield01Icon, flag: Flag01Icon, coffee: Coffee01Icon, target: Target01Icon, compass: Compass01Icon,
  crown: CrownIcon, calendar: Calendar01Icon, clock: Clock01Icon, gameController: GameController01Icon, paintBrush: PaintBrush01Icon,
  magicWand: MagicWand01Icon, tree: Tree01Icon, building: Building01Icon, zap: ZapIcon, diamond: DiamondIcon,
  fire: FireIcon, leaf: Leaf01Icon, mountain: MountainIcon, flower: FlowerIcon, rainbow: RainbowIcon,
  umbrella: UmbrellaIcon, cloud: CloudIcon, anchor: AnchorIcon, puzzle: PuzzleIcon, gift: GiftIcon,
  trophy: Award01Icon, lightbulb: BulbIcon, key: Key01Icon, lock: LockIcon, bell: Notification01Icon,
  mic: Mic01Icon, headphones: HeadphonesIcon, video: Video01Icon, dice: DiceIcon, store: Store01Icon,
  house: House01Icon, plane: PlaneIcon, train: Train01Icon, bike: BicycleIcon, globe2: Globe02Icon,
  paintBucket: PaintBucketIcon, pen: Pen01Icon, ruler: RulerIcon, penTool: PenTool01Icon, startUp: StartUp01Icon,
  bookmark: Bookmark01Icon, bookOpen2: BookOpen02Icon, heart: FavouriteIcon, heartbreak: HeartbreakIcon, cameraAi: CameraAiIcon,
  fireworks: FireworksIcon, diceFaces: DiceFaces01Icon, gameboy: GameboyIcon, pentagon: PentagonIcon, microscope: MicroscopeIcon,
  // Item-kind keyed (ItemList/PanelBar render `Icon name={item.kind}`): the space page (Plan 12 W3)
  // and the sidebar destinations (W4).
  "space-page": Home01Icon,
  "library-page": BookOpen01Icon,
  "connections-page": PlugSocketIcon,
  "notifications-page": Notification02Icon,
  "settings-page": Settings01Icon,
  "profile-page": UserIcon,
} as const;
/** Hugeicons names plus the vendored provider marks — one namespace, so callers (and `AGENT_META`)
 *  never have to know which pack a glyph came from. */
export type IconName = keyof typeof icons | BrandName;
export function isIconName(x: string): x is IconName {
  return Object.prototype.hasOwnProperty.call(icons, x) || isBrandName(x);
}

export function Icon({ name, size = 16, className, colored = false }: { name: IconName | (string & {}); size?: number; className?: string;
  /** Render a brand mark in its vendor's declared colour instead of `currentColor`. Only marks that
   *  declare one change (Claude, Gemini); the rest — and every non-brand glyph — ignore the flag. */
  colored?: boolean }) {
  // Brand marks are filled 24×24 paths, not strokes, so they cannot ride HugeiconsIcon's stroke
  // rendering — but they stay inside this one component and this one name map (§7 allows the agent
  // glyph; everything else is still the Hugeicons stroke-standard set).
  if (isBrandName(name)) {
    const mark = brandMarks[name];
    const fill = colored && "color" in mark ? mark.color : "currentColor";
    return (
      // Decorative like the rest of the set: every mark sits beside text that already names the
      // agent, so announcing "Anthropic" again would only add noise. `data-brand` is the test and
      // CSS hook.
      <svg className={className} data-brand={name} width={size} height={size} viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d={mark.d} fill={fill} fillRule={"evenOdd" in mark ? "evenodd" : undefined} />
      </svg>
    );
  }
  const icon = Object.prototype.hasOwnProperty.call(icons, name) ? icons[name as keyof typeof icons] : icons.folder;
  // Design language §7: stroke weight stays the pack's 1.5px at every size.
  return <HugeiconsIcon icon={icon} size={size} className={className} strokeWidth={1.5} />;
}

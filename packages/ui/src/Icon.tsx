import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon, Cancel01Icon, Folder01Icon, Briefcase01Icon, MortarboardIcon, Home01Icon, UserIcon,
  ComputerTerminal01Icon, GlobeIcon, SmartPhone01Icon, File01Icon, BrainIcon, LayoutGridIcon,
  Settings01Icon, MoreHorizontalIcon, ChatIcon, Search01Icon, PinIcon, PinOffIcon, ArrowLeft01Icon, ArrowRight01Icon,
  Tick01Icon, PencilEdit02Icon, Sun03Icon, Moon02Icon, RefreshIcon,
  SentIcon, StopIcon, SparklesIcon, ArrowDown01Icon, ArrowUp01Icon, ArrowDown02Icon, ArrowUp02Icon, CheckmarkCircle02Icon, CancelCircleIcon,
  Alert02Icon, BotIcon, Wrench01Icon, CodeIcon, IdeaIcon, Copy01Icon, Attachment01Icon, Image01Icon,
  Task01Icon, GitBranchIcon, GitCompareIcon, GitCommitIcon, GitPullRequestIcon, LaptopIcon, PlugSocketIcon, QuoteUpIcon,
  Layout2ColumnIcon, Layout2RowIcon, BookOpen01Icon, Notification02Icon, Download04Icon,
  // Space icon picker's "Default" section (SPACE_ICONS, packages/contracts/src/presets.ts) — every
  // name there must have a matching key below.
  Rocket01Icon, StarIcon, Book01Icon, Camera01Icon, MusicNote01Icon, Shield01Icon, Flag01Icon, Coffee01Icon, RadioButtonIcon, Target01Icon, Compass01Icon,
  CrownIcon, Calendar01Icon, Clock01Icon, GameController01Icon, PaintBrush01Icon, MagicWand01Icon, Tree01Icon, Building01Icon, ZapIcon, DiamondIcon,
  FireIcon, Leaf01Icon, MountainIcon, FlowerIcon, RainbowIcon, UmbrellaIcon, CloudIcon, AnchorIcon, PuzzleIcon, GiftIcon,
  Award01Icon, BulbIcon, Key01Icon, LockIcon, Notification01Icon, Mic01Icon, HeadphonesIcon, Video01Icon, DiceIcon, Store01Icon,
  House01Icon, PlaneIcon, Train01Icon, BicycleIcon, Globe02Icon, PaintBucketIcon, Pen01Icon, RulerIcon, PenTool01Icon, StartUp01Icon,
  Bookmark01Icon, BookOpen02Icon, FavouriteIcon, HeartbreakIcon, CameraAiIcon, FireworksIcon, DiceFaces01Icon, GameboyIcon, PentagonIcon, MicroscopeIcon,
  ArrowExpand01Icon, Minimize01Icon, LayoutTable01Icon, SidebarLeft01Icon, Archive02Icon, ArchiveArrowUpIcon,
  // Inline media playback (MediaView.tsx).
  PlayIcon, PauseIcon, VolumeHighIcon, VolumeOffIcon,
  // The reader's verdict on an assistant message (MessageActions.tsx).
  ThumbsUpIcon, ThumbsDownIcon,
  // The session's summary panel (SessionSummary.tsx).
  InformationCircleIcon,
  ComputerIcon,
  // The sidebar's head row: the gateway call log (SidebarActivity.tsx).
  Pulse01Icon,
  // A machine pane's ⋯ menu: the chord it sends to the guest, and the clipboard it pushes across.
  KeyboardIcon, ClipboardIcon,
  // Hermes Agent's own mark, in this set's hand — see `caduceus` below.
  CaduceusIcon,
  // A session's file browser, laid out as cards (SessionFiles.tsx).
  GridViewIcon,
  // A peek: a session looked at, not opened (the side pane's transient tab, the Agents page's rows).
  ViewIcon,
  // The page about you (YouPage.tsx).
  UserCircleIcon,
  // Settings' pages, each beside its glyph in the column (settings-index.ts), and the Library's toolbar.
  CpuIcon, DashboardSpeed02Icon, Cursor01Icon, CommandIcon, InboxDownloadIcon, FilterHorizontalIcon, LeftToRightListBulletIcon,
  SquareLockPasswordIcon,
  // The permission ladder's marks (Composer's permission control).
  SecurityCheckIcon,
  // A session's Agents tab: one box handing down to two (AgentsTab.tsx).
  HierarchySquare02Icon,
  // The window's two panel toggles: the sidebar on the left, the side pane on the right.
  LayoutLeftIcon, LayoutRightIcon,
  // What a terminal is running, beside its tab's title (terminal-programs.ts in contracts). The
  // language marks are also what a file named in the transcript wears (the renderer's `file-icon.ts`).
  JavaScriptIcon, Typescript01Icon, PythonIcon, GemIcon, JavaIcon, PhpIcon, PackageIcon, ServerStack01Icon, DatabaseIcon,
  // A device's own toolbar (SimulatorBar.tsx): turning it, selecting its elements, its volume down.
  ScreenRotationIcon, CursorRectangleSelection01Icon, VolumeLowIcon,
  // The rest of the kinds of file the transcript names (the renderer's `file-icon.ts`).
  ReactIcon, ThirdBracketSquareIcon, Html5Icon, Css3Icon, SqlIcon, Pdf01Icon, Xml01Icon, Svg01Icon, FileZipIcon, FileScriptIcon,
  // A turn's edits, put back (EditSummary.tsx).
  Undo02Icon,
  // A view an MCP server drew (AppView.tsx), as a tab and under its tool call.
  WebDesign01Icon,
  // The media viewer's zoom out, beside `add` for zoom in (components/viewer/ViewerStage.tsx).
  MinusSignIcon,
} from "@hugeicons-pro/core-stroke-rounded";
import type { IconSvgElement } from "@hugeicons/react";
import { brandMarks, isBrandName, type BrandName } from "./brand-icons";

/* Two shields the pack does not draw — one asking, one warning — made of its own parts: Shield01's
   outline (the one SecurityCheck draws its tick inside), with HelpCircle's question mark and
   AlertCircle's exclamation scaled into the interior the tick occupies. Same stroke, same caps, same
   grid, so the three permission marks read as one family rather than two packs and a drawing. */
const interior = (d: string, key: string) =>
  ["path", { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5", key }] as const;
const ShieldQuestionIcon: IconSvgElement = [
  Shield01Icon[0]!,
  interior("M10 9C10 7.89543 10.8954 7 12 7C13.1046 7 14 7.89543 14 9C14 9.6855 13.6551 10.2905 13.1294 10.6509C12.5826 11.0255 12 11.5373 12 12.2", "1"),
  interior("M12 15H12.0072", "2"),
];
const ShieldAlertIcon: IconSvgElement = [
  Shield01Icon[0]!,
  interior("M12 7.5V11.5", "1"),
  interior("M12 14.4883V14.4983", "2"),
];

export const icons = {
  add: Add01Icon, close: Cancel01Icon, folder: Folder01Icon, briefcase: Briefcase01Icon, cap: MortarboardIcon,
  home: Home01Icon, user: UserIcon, terminal: ComputerTerminal01Icon, browser: GlobeIcon, simulator: SmartPhone01Icon,
  artifact: File01Icon, documents: File01Icon, context: BrainIcon, layout: LayoutGridIcon, settings: Settings01Icon, more: MoreHorizontalIcon,
  sidebar: SidebarLeft01Icon,
  session: ChatIcon, search: Search01Icon, pin: PinIcon, unpin: PinOffIcon, chevronLeft: ArrowLeft01Icon, chevronRight: ArrowRight01Icon,
  check: Tick01Icon, trash: Cancel01Icon, edit: PencilEdit02Icon, sun: Sun03Icon, moon: Moon02Icon,
  send: SentIcon, stop: StopIcon, sparkles: SparklesIcon, chevronDown: ArrowDown01Icon, chevronUp: ArrowUp01Icon, arrowDown: ArrowDown02Icon, arrowUp: ArrowUp02Icon,
  checkCircle: CheckmarkCircle02Icon, errorCircle: CancelCircleIcon, alert: Alert02Icon, bot: BotIcon, tool: Wrench01Icon, code: CodeIcon, idea: IdeaIcon,
  /* Hermes Agent's glyph (AGENT_META), and the one agent here whose mark is NOT vendored into
     brand-icons.ts. Nous Research publishes no vector for it: the docs site's favicon is the
     Unicode ⚕ set as text and the README titles it with ☤, so there is no path data to lift and
     drawing one would be inventing a mark rather than reproducing one. The staff is what the
     vendor is pointing at, so this set's own caduceus says the same thing in the app's hand — a
     familiar symbol over a new illustration, and honest about which it is. */
  caduceus: CaduceusIcon,
  copy: Copy01Icon, plan: Task01Icon, attach: Attachment01Icon, image: Image01Icon, reload: RefreshIcon,
  /* The opening quotation mark, for quoting a passage of the transcript into the prompter. The
     leading mark rather than `QuoteDown`: it is the one a reader sees at the START of a quotation,
     and the pair reads as punctuation rather than as an apostrophe only in that orientation. */
  quote: QuoteUpIcon,
  thumbsUp: ThumbsUpIcon, thumbsDown: ThumbsDownIcon, info: InformationCircleIcon,
  branch: GitBranchIcon, diff: GitCompareIcon, commit: GitCommitIcon, pullRequest: GitPullRequestIcon,
  splitRight: Layout2ColumnIcon, splitDown: Layout2RowIcon,
  /* Pane focus (zoom one pane to the whole host) and its inverse; `group` is a pane group's tab.
     Focus is the two-arrow diagonal — the corner-to-corner expand every window control in every OS
     draws. The pack's `Maximize01` is a PINCH GESTURE: a hand with a thumb and finger and two small
     arrows, which at 14px is a smudge that says nothing about what the button does. */
  focusPane: ArrowExpand01Icon, unfocusPane: Minimize01Icon, group: LayoutTable01Icon,
  // The same glyph under the name a document is looking for. A plan card opening its full text is
  // not focusing a pane, and a call site should not have to borrow the pane system's word for it.
  expand: ArrowExpand01Icon,
  play: PlayIcon, pause: PauseIcon, volumeOn: VolumeHighIcon, volumeOff: VolumeOffIcon,
  // Two rings: the record mark, as iOS's own Screen Recording control draws it — not a radio button here.
  record: RadioButtonIcon,
  // Same glyph as `group`, under the name a spreadsheet is actually looking for — a document's
  // icon should not have to borrow the pane system's vocabulary to find a table.
  table: LayoutTable01Icon,
  /* Four separate tiles: the view-as-icons mark every file browser draws. Not `layout`, which is one
     square quartered by two rules — at 12px that reads as a single box, and it already stands for
     "All spaces…" and the simulator's element overlay. */
  grid: GridViewIcon,
  /* An eye: a session LOOKED AT rather than opened. On the peek's tab it stands where the kind's
     glyph does, which is what marks the tab as one that will not stay. */
  peek: ViewIcon,
  laptop: LaptopIcon, plug: PlugSocketIcon, download: Download04Icon,
  /* A trace, not a bar chart: `Activity01` and its siblings draw the line inside a framed box, and
     at 14px beside the sidebar toggle the frame is most of what survives — two glyphs that read as
     two panels. The bare pulse says "things happening" at that size. */
  activity: Pulse01Icon,
  keyboard: KeyboardIcon, clipboard: ClipboardIcon,
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
  "schedules-page": Clock01Icon,
  /* Missing for as long as the Agents page has existed: `Icon` falls back to `icons.folder` for a
     name it does not hold, silently, so the page wore a folder in the sidebar and in its own pane
     bar. `icon-kinds.test.ts` is what stops the next one lasting that long. */
  "agents-page": BotIcon,
  /* A session's own sub-agents: one box handing work down to two. Not the page's bot — the page is
     every agent there is, and this is the tree under one session, which is the thing the shape says. */
  agents: HierarchySquare02Icon,
  /* A window with a layout drawn in it: an interface somebody else made. Not `browser`'s globe, which
     is a page anywhere on the web, and not `layout`, which is Realm arranging its own panes. */
  "app-view": WebDesign01Icon,
  /* A face in a circle, set apart from `profile-page`'s bare figure: the profile is a scope (its
     skills, connections and memory), and this page is the person. */
  "you-page": UserCircleIcon,
  /* A monitor on a stand, and deliberately not `laptop`, which is taken and means THIS Mac — the one
     Realm is running on, in the computer-use surfaces. A machine is a screen somewhere else. */
  machine: ComputerIcon,
  /* Settings' pages, as the column lists them. An engine is the CLI a session runs on, so a chip; what
     it costs is a gauge, the meter Codex puts beside its own usage page; an agent driving this Mac's
     apps is the plain arrow it moves (the pack's `CursorPointer` rings the arrow with a filled ripple
     that is a blob at 16px) — named `pointer`, because `cursor` is the Cursor editor's brand mark and a
     brand name wins the lookup; shortcuts are the ⌘ every Mac menu prints beside them — the pack's
     `Keyboard` is a face at row size; and an import is the tray things arrive in. */
  cpu: CpuIcon, gauge: DashboardSpeed02Icon, pointer: Cursor01Icon, command: CommandIcon, inboxDownload: InboxDownloadIcon,
  /* A saved password's mark: a padlock. `lock` is the pack's round keyhole, which at 16px is a circle
     with a dot — and it stays as it is, because it is a space icon people have already picked. */
  padlock: SquareLockPasswordIcon,
  /* The Library's toolbar: the narrowing a filter menu does, and the view as rows beside `grid`'s
     view as tiles — the pair every file browser draws. */
  filter: FilterHorizontalIcon, list: LeftToRightListBulletIcon,
  /* How freely a session's agent may act, as the prompter's permission control draws it: a shield
     that asks (Ask each time), one that has already said yes (Accept edits), and one that warns
     (Full access) — the rung that takes the gate away is the one whose mark says so. */
  shieldQuestion: ShieldQuestionIcon, shieldCheck: SecurityCheckIcon, shieldAlert: ShieldAlertIcon,
  /* The window's panel toggles, as Codex and every Mac editor draw them: a window with the panel
     ruled off at its side. `sidebar` is the older glyph with list rows drawn in the panel — at 14px
     beside the traffic lights the rows were a smudge, and the bare rule is the cleaner mark. */
  panelLeft: LayoutLeftIcon, panelRight: LayoutRightIcon,
  /* What a terminal's foreground program is, when it is a tool rather than an agent (an agent wears
     its vendor's mark). The language for a runtime — node is the JS square, deno the TS one, Ruby a
     gem — and the job for the rest: a package manager is a parcel, which is also what a dev server
     started through one wears, and a container runtime is the server stack it stands for. */
  javascript: JavaScriptIcon, typescript: Typescript01Icon, python: PythonIcon, gem: GemIcon, java: JavaIcon, php: PhpIcon,
  package: PackageIcon, serverStack: ServerStack01Icon, database: DatabaseIcon,
  /* A device's own controls. Rotate is a phone turning between two arrows — the `reload` arrow it wore
     says "load again". The elements overlay is a selection drawn over the screen, the pointer in a
     dashed box. Volume down is the speaker with one wave: the struck-through one it borrowed from
     playback says mute, which is a different button. */
  rotate: ScreenRotationIcon, select: CursorRectangleSelection01Icon, volumeLow: VolumeLowIcon,
  /* What kind of file a path names, where the pack draws it: a language's own badge (the TS and JS
     squares Codex marks its file links with are the terminal's `typescript` and `javascript` above;
     `{ }` for JSON, the HTML and CSS shields), the format's letters in a page for the rest, and a page
     with `< >` on it for source the pack has no mark for. */
  fileReact: ReactIcon, fileJson: ThirdBracketSquareIcon, fileHtml: Html5Icon, fileCss: Css3Icon, fileSql: SqlIcon,
  filePdf: Pdf01Icon, fileXml: Xml01Icon, fileSvg: Svg01Icon, fileZip: FileZipIcon, fileCode: FileScriptIcon,
  /* The open arc turning back — the mark Codex sets beside its own Undo, and what every editor draws
     for it. Not `reload`, whose closed circle means "again", which is the opposite. */
  undo: Undo02Icon,
  /* A picture's zoom out, the plain bar beside the plain plus — the pair every image viewer's −/+
     is, which a magnifier holding either sign only restates at a size where the sign is a speck. */
  minus: MinusSignIcon,
} as const;
/** Hugeicons names plus the vendored provider marks — one namespace, so callers (and `AGENT_META`)
 *  never have to know which pack a glyph came from. */
export type IconName = keyof typeof icons | BrandName;
export function isIconName(x: string): x is IconName {
  return Object.prototype.hasOwnProperty.call(icons, x) || isBrandName(x);
}

/**
 * The size ladder. `size` is a free number, so the only thing stopping 21 call sites from drifting
 * to 21 values is this list — pick the rung whose ROLE matches, never the one that happens to look
 * right in one place. Rungs are 2px apart because 1px apart is not a difference a reader can see:
 * two controls in one 22px box at 12 and 13 read as a mistake, not as a distinction.
 *
 *   20  card     the glyph IS the card's subject, at card scale (.space-card)
 *   18  tile     the glyph IS the tile's subject (.pinned-grid .tile)
 *   16  row      what a row or a strip square IS — item kind, destination, space, profile
 *   14  control  a button's verb (.icon-btn, .sb-toggle, .panel-bar) and a field's leading glyph
 *   12  inline   inside a box of 22px or less (.item-close, .item-shelf), or leading text at 12.5px
 *
 * Role, not local font size: the overview's filter field sets 15px text and the sidebar's search
 * 13px, and both take the 14 rung, because in both the glyph is the affordance and not the content.
 */
export function Icon({ name, size = 16, className, colored = false }: { name: IconName | (string & {}); size?: number; className?: string;
  /** Render a brand mark in its vendor's declared colour instead of `currentColor`. Only marks that
   *  declare one change (Claude, Gemini); the rest — and every non-brand glyph — ignore the flag. */
  colored?: boolean }) {
  // Brand marks are filled paths, not strokes, so they cannot ride HugeiconsIcon's stroke
  // rendering — but they stay inside this one component and this one name map (§7 allows the agent
  // glyph; everything else is still the Hugeicons stroke-standard set).
  if (isBrandName(name)) {
    const mark = brandMarks[name];
    const fill = colored && "color" in mark ? mark.color : "currentColor";
    const paths: readonly string[] = typeof mark.d === "string" ? [mark.d] : mark.d;
    const viewBox = ("viewBox" in mark && mark.viewBox) || "0 0 24 24";
    /* `size` is the glyph's HEIGHT, and the width follows the mark's own aspect.
       Most marks are square and this changes nothing. A WORDMARK is not — E2B publishes "E2B" at
       104×30 — and forcing one into a square box letterboxes it to a third of the rung, which is the
       difference between a logo and a smudge. The rung has always meant "how tall is this glyph in
       this row"; only the square marks let the two readings look identical. */
    const [, , vbW = 24, vbH = 24] = viewBox.split(/[\s,]+/).map(Number);
    const width = vbH > 0 ? Math.round(size * (vbW / vbH)) : size;
    return (
      // Decorative like the rest of the set: every mark sits beside text that already names the
      // agent, so announcing "Anthropic" again would only add noise. `data-brand` is the test and
      // CSS hook.
      <svg className={className} data-brand={name} width={width} height={size} viewBox={viewBox}
        xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        {paths.map((d, i) => <path key={i} d={d} fill={fill} fillRule={"evenOdd" in mark ? "evenodd" : undefined} />)}
      </svg>
    );
  }
  const icon = Object.prototype.hasOwnProperty.call(icons, name) ? icons[name as keyof typeof icons] : icons.folder;
  return <HugeiconsIcon icon={icon} size={size} className={className} strokeWidth={iconStroke(size)} absoluteStrokeWidth />;
}

/**
 * The glyph `Icon` draws, as markup — for the one renderer that writes HTML rather than React:
 * assistant markdown, where a file the agent names is drawn as a link wearing its file type's mark.
 * The same data and the same stroke rule, so the string and the component cannot draw two glyphs.
 * Stroke glyphs only; a brand mark has its own string form beside it (`brandMarks`).
 */
export function iconSvg(name: IconName | (string & {}), size: number, className = ""): string {
  const stroke = (iconStroke(size) * 24) / size;
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // The same fallback `Icon` takes for a name it does not hold.
  const icon = Object.prototype.hasOwnProperty.call(icons, name) ? icons[name as keyof typeof icons] : icons.folder;
  const parts = icon.map(([tag, attrs]) => {
    const list = Object.entries(attrs).filter(([k]) => k !== "key")
      .map(([k, v]) => `${kebab(k)}="${k === "strokeWidth" ? stroke : String(v)}"`);
    return `<${tag} ${list.join(" ")}/>`;
  });
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

/**
 * The stroke a glyph is drawn with, in CSS px, for the rung it sits on.
 *
 * The pack's 1.5 is in its own 24-unit grid, so left alone it SCALES with the glyph: 0.75px at the
 * 12 rung, 0.875 at 14 — a hairline that greys out beside 13px text, which is most of why Realm's
 * icons read fainter than the label next to them. A Mac's symbols do the opposite: a small symbol is
 * drawn relatively HEAVIER so it holds the same weight as the text it sits in. So the stroke has a
 * floor at the small rungs and a ceiling at the large ones, and rises between: 1.125 at 12, 1.17 at 14,
 * 1.33 at 16, 1.5 from 18 up.
 */
export function iconStroke(size: number): number {
  return Math.min(1.5, Math.max(1.125, size / 12));
}

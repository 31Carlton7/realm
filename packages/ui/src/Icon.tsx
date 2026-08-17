import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon, Cancel01Icon, Folder01Icon, Briefcase01Icon, MortarboardIcon, Home01Icon, UserIcon,
  ComputerTerminal01Icon, GlobeIcon, SmartPhone01Icon, File01Icon, BrainIcon, LayoutGridIcon,
  Settings01Icon, MoreHorizontalIcon, ChatIcon, Search01Icon, PinIcon, PinOffIcon, ArrowLeft01Icon, ArrowRight01Icon,
  Tick01Icon, Delete02Icon, PencilEdit02Icon, Sun03Icon, Moon02Icon,
} from "@hugeicons-pro/core-stroke-rounded";

export const icons = {
  add: Add01Icon, close: Cancel01Icon, folder: Folder01Icon, briefcase: Briefcase01Icon, cap: MortarboardIcon,
  home: Home01Icon, user: UserIcon, terminal: ComputerTerminal01Icon, browser: GlobeIcon, simulator: SmartPhone01Icon,
  artifact: File01Icon, context: BrainIcon, layout: LayoutGridIcon, settings: Settings01Icon, more: MoreHorizontalIcon,
  session: ChatIcon, search: Search01Icon, pin: PinIcon, unpin: PinOffIcon, chevronLeft: ArrowLeft01Icon, chevronRight: ArrowRight01Icon,
  check: Tick01Icon, trash: Delete02Icon, edit: PencilEdit02Icon, sun: Sun03Icon, moon: Moon02Icon,
} as const;
export type IconName = keyof typeof icons;
export function isIconName(x: string): x is IconName { return Object.prototype.hasOwnProperty.call(icons, x); }

export function Icon({ name, size = 16, className }: { name: IconName | (string & {}); size?: number; className?: string }) {
  const icon = isIconName(name) ? icons[name] : icons.folder;
  return <HugeiconsIcon icon={icon} size={size} className={className} strokeWidth={1.5} />;
}

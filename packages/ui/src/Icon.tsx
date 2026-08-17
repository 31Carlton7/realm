import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon, Cancel01Icon, Folder01Icon, Briefcase01Icon, MortarboardIcon, Home01Icon, UserIcon,
  ComputerTerminal01Icon, GlobeIcon, SmartPhone01Icon, File01Icon, BrainIcon, LayoutGridIcon,
  Settings01Icon, MoreHorizontalIcon, ChatIcon,
} from "@hugeicons-pro/core-stroke-rounded";

export const icons = {
  add: Add01Icon, close: Cancel01Icon, folder: Folder01Icon, briefcase: Briefcase01Icon, cap: MortarboardIcon,
  home: Home01Icon, user: UserIcon, terminal: ComputerTerminal01Icon, browser: GlobeIcon, simulator: SmartPhone01Icon,
  artifact: File01Icon, context: BrainIcon, layout: LayoutGridIcon, settings: Settings01Icon, more: MoreHorizontalIcon,
  session: ChatIcon,
} as const;
export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, className }: { name: IconName | string; size?: number; className?: string }) {
  const icon = (icons as Record<string, (typeof icons)[IconName]>)[name] ?? icons.folder;
  return <HugeiconsIcon icon={icon} size={size} className={className} strokeWidth={1.5} />;
}

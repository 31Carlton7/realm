/** Moved to contracts (`key-event.ts`), where main reads keystrokes with the same parser. Re-exported
 *  here so the renderer's keybinding layer keeps importing from its own folder. */
export { chordFromEvent, type KeyEventLike } from "@realm/contracts";

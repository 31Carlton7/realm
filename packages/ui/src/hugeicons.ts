/* The Hugeicons glyphs `Icon.tsx` draws, under the export names it imports them by (`#hugeicons`).

   This module is the free pack, `@hugeicons/core-free-icons`, which anyone can install. Where the Pro
   pack is installed — it comes from Hugeicons' own registry and needs the owner's token
   (docs/dev/hugeicons.md) — the bundler puts `@hugeicons-pro/core-stroke-rounded` in this module's
   place (`hugeiconsAlias` in hugeicons-pack.ts), so those builds draw exactly what they always have.
   Every typecheck reads this file, with the Pro pack or without it.

   The free pack is the same Stroke Rounded set under the same names; at 1.2.1 its glyphs are the Pro
   pack's byte for byte. A glyph only the Pro pack draws has no export here, so the typecheck stops at
   `Icon.tsx`'s import until it is given one: the free pack's nearest glyph if one says the same thing,
   and otherwise its folder, the glyph `Icon` already draws for a name it does not hold —

     export { Folder01Icon as SomeProOnlyIcon } from "@hugeicons/core-free-icons";
*/
export * from "@hugeicons/core-free-icons";

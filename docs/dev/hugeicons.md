# Hugeicons
Icons come from `@hugeicons/react` and a Hugeicons Stroke Rounded pack, which `packages/ui/src/Icon.tsx` imports from `#hugeicons`:

- `@hugeicons-pro/core-stroke-rounded` where it is installed. The Pro registry needs a token: put the registry + token lines in `~/.npmrc` (user-level) or in a `.npmrc` at repo root (see `.npmrc.example`); never commit the repo `.npmrc`.
- `@hugeicons/core-free-icons` (MIT) everywhere else, through `packages/ui/src/hugeicons.ts`, under the same export names.

The Pro pack is an optional dependency, so `pnpm install` without the token skips it and the one lockfile installs either way. pnpm says nothing about the skip (it still lists the package as added); the desktop build does, with `[hugeicons] the Pro pack is not installed; drawing the free pack`. CI checks that the pack installed on every run that has the secret.

`hugeiconsAlias()` (`packages/ui/src/hugeicons-pack.ts`) is how a Vite config swaps `#hugeicons` for the Pro pack: the renderer build and the desktop and ui test configs use it. The typecheck reads `hugeicons.ts` either way, so a glyph only the Pro pack draws fails it until `hugeicons.ts` names a free stand-in (its comment says how). `packages/ui/src/hugeicons.test.ts` checks that every name `Icon.tsx` imports is in the free pack and, where it is installed, the Pro pack, and that the glyphs drawn are the installed pack's own.

Keep the two packs on the same version. At 1.2.1 the free pack's glyphs are the Pro pack's path for path, so a build without the token looks the same, and the iPhone's marks (`apps/ios/scripts/marks.mjs`, drawn from whichever pack is installed) match either.

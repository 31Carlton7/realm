# Vendored: Pixel Agents

The office engine and the pixel art in this package are **not Realm's work**. They are vendored from
[pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) by Pablo De Lucca,
which renders the agents running in your terminals as characters working in a tiny office.

## What is from where

| Path | Origin | Licence |
| --- | --- | --- |
| `src/vendor/**` | `webview-ui/src/office/**`, `webview-ui/src/constants.ts`, `webview-ui/src/components/ui/types.ts`, `core/src/paletteUtils.ts` | MIT — © 2026 Pablo De Lucca (`src/vendor/LICENSE`) |
| `tools/**` | `core/src/assets/**` — the PNG decoder and catalog builder, run at vendor time only | MIT, same |
| `assets/characters/**` | [MetroCity Free Topdown Character Pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) by JIK-A-4, via the above | CC0 1.0 (public domain). Credit is not required; it is given anyway. |
| `assets/{floors,walls,carpets,furniture}/**` | same upstream repository | MIT / CC0 as above |
| `src/*.ts`, `src/*.tsx` outside `src/vendor` | Realm | Realm's own licence |

Both licences permit what this does, including commercial use and redistribution. The MIT notice
travels with the code in `src/vendor/LICENSE`, and both authors are credited in the app's
attribution panel.

## What was taken, and what was not

Taken: the engine — `officeState`, `renderer`, `characters`, `gameLoop`, the sprite and layout
modules, the tile and colorize maths. Twenty-nine files, no external dependency but React.

Realm's own, in `src/` outside `src/vendor`: the canvas and frame loop (`OfficeView.tsx`), the
reconcile from Realm sessions to office characters (`bridge.ts`), the validators that stand between a
language model and the renderer (`world.ts`, `sprite.ts`), the theme layer (`theme.ts`), and the
asset installation (`assets.ts`).

Not taken: the upstream layout **editor** UI, the VS Code extension host, the standalone server, the
transport layer, pets, areas, and sound. Realm drives the office from its own session state and
changes the world through the prompter rather than through a paint editor, so none of that has a job
here. `OfficeCanvas.tsx` was deliberately left behind too — it is welded to the editor's props, and
Realm's canvas (`src/OfficeView.tsx`) owns its own frame loop so it can obey Realm's reduced-motion
and `data-quiet` power rules, which a ported component would not have known about. Upstream's
`startGameLoop` is an unconditional `requestAnimationFrame`, which is correct in a VS Code webview
and would burn a core in an unfocused Realm window.

## Keeping it in step with upstream

The vendored files are kept as close to upstream as possible so a future re-sync is a diff rather
than an archaeology exercise. Two deliberate deviations, both mechanical:

1. `core/src/paletteUtils.js` imports were repointed to `../core/paletteUtils.js` inside this package.
2. `noUncheckedIndexedAccess` is off in `tsconfig.json`. Realm has it on repo-wide; upstream does not
   and indexes arrays freely. Turning it off here costs Realm nothing (nothing outside this package
   loses the check) and is the difference between a re-sync and a rewrite.

To re-sync: clone upstream, copy the files listed above, re-apply those two deviations, then run
`pnpm --filter @realm/pixel-office decode-assets`.

## Assets are decoded at vendor time, not at runtime

`assets/decoded.json` is generated from the PNGs by `tools/decode-assets.mts` and committed. The
renderer imports it and never touches a PNG.

That is not a performance decision, it is a correctness one. Realm's renderer is loaded from
`file://`, and a `file://` image drawn into a canvas taints it — `getImageData` then throws a
`SecurityError`, which is exactly what the upstream decode path does on every sprite. Decoding once,
on Node, at vendor time, sidesteps the whole question and costs 0.8 MB of JSON that gzips well.

Re-run `pnpm --filter @realm/pixel-office decode-assets` after changing anything under `assets/`.

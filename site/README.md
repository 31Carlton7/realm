# realm-site

The marketing site for Realm — Next.js 16 and Tailwind 4, over real captures of the app.

Three routes and nothing else:

| Route | What it is |
| --- | --- |
| `/` | The landing page, laid out in [The landing page](#the-landing-page) below. |
| `/changelog`, `/changelog/[slug]` | Every notable change under one date marker per day, eight at a time behind a **Load more**; each one opens as an article. |
| `/features` | One non-scrolling screen: a carousel of real captures of the app, arrow keys included. |

The entries live in `content/changelog.ts` as typed blocks rather than Markdown — the site sits
outside the workspace's vitest projects, so a union the compiler checks beats a parser nothing can
test. `components/changelog/Prose.tsx` renders them; inline `` `code` `` and `**bold**` are the only
spans.

```sh
cd site
pnpm install
pnpm dev        # http://localhost:3100
```

## The landing page

`app/page.tsx` renders `components/realms/RealmsHome`: one flight across a field of Realm's mark,
scrubbed by the reader's scroll and drawn by one WebGPU canvas behind the whole page (`Flight`, the
stage in `components/realms/stage.ts` on the runtime in `components/field/`). The layout is the DOM's
and the field reads it every frame from `data-field-anchor`: `copy` and `portal` for the opening's
words and window, `k:<id>` for the words a stop is composed around (or `p:<id>` for its picture, where
the words stand above it), `s:<id>` for the slot a chapter's picture lands in, `c:<name>` for any other
words the field keeps its light off.

| Section | Component | What it does |
| --- | --- | --- |
| Opening | `realms/HeroParts`, `home/mini/MiniRealm` | The 2.1 link, the headline, and a working sample of Realm's window you can click through, labelled as one; its copy is `content/mini-realm.ts`. |
| What a realm holds | `realms/Chapter` (`stacked`) | The six things a space holds, then the whole window across the page. |
| The claims | `realms/Chapter`, `realms/Screen` | One chapter per claim in `content/home.ts`, sides alternating: the words, and the part of the window the claim is about, photographed on its own. |
| Teams | `realms/Team`, `lib/realmite` | 2.1's teams, clickable, with a Realmite at each of the team's doors in the field. |
| Facts, questions | `realms/RealmsHome` | Where the work lives, and the questions. |
| Close | `realms/RealmsHome` | The download once more as the camera climbs off the field. |

Words over the field stand on a pane of it (`realms/FieldPanel`): the field blurred and dimmed behind
them, a hairline edge, and the blur carried a little past it. The composite pass dims the field inside
exactly the pane's rounded rect and nowhere else.

A picture is `realms/Screen`: a capture at its own size and shape, never cropped by the page, with the
surface's own corner and the one-device-pixel inset outline, set on a plate of the field's dark lit
from above — a rim of the doorways' light, the lattice in its margin, the pointer's lamp on the rim in
the flight. Its caption hangs from the middle of the plate's foot on a tab cut from it, and the hero's
working sample wears the same plate with its label on the top edge. A claim can name a narrower
capture for phones (`phone` in `content/home.ts`), taken in a window a phone's width.

The rules it keeps: every effect argues something the copy also says, motion follows the reader
rather than looping, `prefers-reduced-motion` drops the transitions, and a picture is either a real
capture or plainly drawn. Focus rings draw inside a clipped surface (the hero window, a card, a
scrolling tab row) so the clip cannot cut them off.

## Why it is not in the pnpm workspace

The root `pnpm-workspace.yaml` globs `apps/*` and `packages/*`. `site/` is deliberately outside both,
and carries its own `pnpm-workspace.yaml` with `packages: []` so pnpm stops searching upward.

That file is load-bearing. Without it, `pnpm install` run inside `site/` finds the monorepo root and
installs **all six workspace projects** — Electron, `node-pty`, and the private Hugeicons Pro registry
that a Vercel build has no token for. With it, the install resolves against `site/pnpm-lock.yaml`
alone: 63 packages, no native builds, no private registry.

## Deploying to Vercel

Import the repository and set exactly one thing:

| Setting | Value |
| --- | --- |
| **Root Directory** | `site` |

Framework preset, install command and build command all come from `vercel.json`. Leave *Include
source files outside of the Root Directory* **off** — the site needs nothing from the rest of the
repository.

Every changelog entry is prerendered at build time. `/` and `/changelog` revalidate hourly, for the
release lookup described below.

### Optional environment

| Variable | Effect |
| --- | --- |
| `NEXT_PUBLIC_REPO_URL` | Overrides the GitHub link. The default in `lib/site.ts` points at the public repository. |

## The download button

`lib/release.ts` asks GitHub for the latest release and links its `.dmg` directly, cached for an
hour. The disk image is named for its version (`Realm-0.6.0-arm64.dmg`), so there is no fixed URL
that always points at the newest one — resolving it at render is what keeps the button from going
stale a release after someone last edited the file. Rate limit, network failure or a release with no
disk image all fall back to the releases page, which is always true.

Because of that fetch, `/` and `/changelog` revalidate hourly rather than being pure static output;
the entry pages are fully prerendered.

## The feature captures

`scripts/capture-product.mjs` boots the BUILT app (`pnpm build` at the repo root first) on a
disposable `REALM_HOME`, stages a profile's worth of work through the same RPC and UI paths a person
uses — five spaces across two profiles, sessions waiting, working and finished, a delegation, three
scheduled tasks and a run, a Library — and screenshots a list of scenes at 1440×900 and 3× density
into `.captures/` (not in git). `scripts/encode-product.mjs` then writes what the site serves, all of
it lossless WebP: every scene at 1× and as shot (`public/product/<scene>-1440.webp`, `-4320.webp`),
each part of the window the landing page shows on its own, and its phone cut where it has one
(`public/product/parts/`, with each one's size and corner in `parts.json`), and the crops the
changelog's figures import
(`public/product/details/`). `pnpm capture:encode` re-runs that step alone.

```sh
pnpm build                      # from the repo root — a stale build reads as a live bug
pnpm --filter realm-site capture:product
```

Nothing it runs is billed and nothing reaches GitHub: Claude and Codex are the scripted agent
(`REALM_FAKE_STANDS_IN`), so the chips still name the models a real session runs, and Code review
reads the fixture pull requests through a fake `gh`. Nothing of the developer's is reached either:
the app gets an allowlisted environment and the system's PATH, so no agent CLI of theirs is probed,
and the server reads skills, Claude and Codex files from empty folders of the run's own
(`REALM_USER_HOME`). The window is the harness's capture window (`REALM_LIVE_SCRATCH=capture`,
`apps/desktop/src/main/live-scratch.ts`): invisible, unfocusable and click-through, so a run never
comes in front of whoever is at the Mac. `REALM_CAPTURE_SERVER_PORT`, `REALM_CAPTURE_CDP_PORT` and
`REALM_CAPTURE_SCRATCH` move its ports and its scratch home; `REALM_CAPTURE_ONLY` runs a subset, for
diagnosis; `REALM_CAPTURE_HOLD=<minutes>` keeps the staged app up afterwards, for trying a new scene's
selectors over DevTools.

Scenes are independent and each is wrapped: a selector that has moved loses one image and prints
why, rather than ending the run. The names that survived are written to
`public/product/manifest.json`, and the landing page shows a claim's whole scene only where that scene
is in it — so a broken scene drops out instead of shipping a hole.

Four things the script and the pages are careful about, all of which have bitten:

- **Sharpness.** A claim used to zoom into part of its scene, and a 2× capture zoomed that far drew
  fewer than two image pixels per CSS pixel on a Retina screen. Next's optimiser made it worse: it
  served every capture as lossy WebP at quality 75 with the colour at half resolution, which smears
  small text. So the window is shot at 3×, a claim's part is photographed on its own at that density
  and drawn near the size it has in the app, and the pages serve the files as written, never through
  `/_next/image`.

- **The computer name.** Every shot walks its text nodes and replaces the developer's machine name,
  and the scratch home's path, before capturing. It is not enough to do it once during staging —
  each composer redraws it.
- **The display.** The window renders in sRGB (`--force-color-profile=srgb`). Left to the display, a
  capture carries that display's own profile, and the same scene came out vivid from an external
  screen and washed out from the Mac's P3 panel.
- **The browser pane.** There is deliberately no browser scene: the pane is a native
  `WebContentsView`, and a renderer screenshot cannot see its pixels.

## The mark, and the glass

The mark is flat: the cube's silhouette with the doorway cut out of it. `scripts/render-icons.mjs`
(`node scripts/render-icons.mjs`) draws every file of it the site serves, two ways:

- **One colour**, for small uses. `public/icon.svg` is the favicon, dark ink on a light tab strip and
  light ink on a dark one (`prefers-color-scheme`); `app/favicon.ico` is the same mark in white on a
  Realm-blue tile, for browsers that ask for an .ico; `public/mask-icon.svg` is Safari's pinned tab.
  The header and footer draw the mark inline beside the name (`components/Wordmark.tsx`), in the
  text colour.
- **Three flat planes**, top `#9cc1ff`, left `#4f8cf5`, right `#2457c4`, for the app icon:
  `public/realm-mark.svg` wherever the page shows the mark large, `public/apple-icon.png` (full-bleed,
  iOS rounds it) and `public/app-icon.png` (the tile inset the way the Dock draws it). The share
  images come from `/share` (`pnpm capture:share`), whose wordmark carries this mark.

`app/layout.tsx` lists the icons rather than leaving them to Next's file names, because Safari's mask
icon has no file convention and naming any icon in the metadata replaces the file-based ones.

`lib/mark.ts` works the mark's geometry out the way `mark.mjs` does: its six faces, the walls and
the doorway's floor, jamb and back. The landing page's field builds every realm on it from exactly that
drawing (`components/realms/hive/cube.ts`), the cube with its doorway cut where the logo cuts it. Separately, `lib/realm-liquid-glass.ts` bakes the same mark's walls into a signed distance field and refracts
Realm-blue, white and silver light streams through it, and `components/RealmCanvas.tsx` runs it —
pausing offscreen and in a hidden tab, one frozen frame under reduced motion, the vector mark where
WebGPU is unavailable. No page mounts it now: the landing page leads with a capture of the product,
and the mark sits in the lockup, where a shader would draw a smudge.

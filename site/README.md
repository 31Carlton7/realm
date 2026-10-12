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

`app/page.tsx` stacks one component per section, top to bottom. One WebGPU field
(`components/dimension/DimensionField`) sits behind all of it; a section marks where it is with
`data-dim-stage`, and an element the field should light marks itself with `data-dim`.

| Section | Component | What it does |
| --- | --- | --- |
| Header | `SiteHeader` (`floating`) | Inset from the viewport edge, the download always one click away. |
| Hero | `app/page.tsx`, `home/mini/MiniRealm` | The 2.0 link, the headline, and a working sample of Realm's window: pick a session, open a side-panel tab, answer what's waiting. A segmented row under it jumps between five views. Labelled as a sample; its copy is `content/mini-realm.ts`. |
| Agents | `home/AgentStrip` | The agents Realm runs, as one still row of their marks (`lib/agent-marks.ts`). |
| What a realm is made of | `home/SixFaces` | The pinned WebGPU track: the mark assembles face by face. |
| Capability grid | `home/Bento`, `home/SpotlightGrid` | Nine cards on a slab chamfered at the mark's 60°. Each picture is drawn in the app's tokens, or a capture cut to the component it shows (`Crop`). The rims light toward a mouse pointer (`.spot` in `globals.css`); touch keeps the resting rim. |
| Delegation | `home/Delegation` | The pinned interlude: one agent starting more, two levels deep. |
| Proof | `home/Proof` | The claims in `content/home.ts` as one tabbed viewer, each with its real capture. WAI-ARIA tabs: arrow keys, Home and End. |
| Teams | `home/Teams`, `lib/realmite` | 2.1's teams, clickable: roles wearing Realmites (the app's generator, ported whole), handoffs, and a Review you can approve from. |
| Facts | `home/LocalFacts` | Four lines on where the work lives. |
| Questions, close | `home/Faq`, `home/CloseCta` | The questions, then the download through a portal. |
| Footer | `home/Footer` | The flat cube rising over its lattice. |

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
each landing claim's own cut of its scene (`public/product/claims/`), and the crops the changelog's
figures import (`public/product/details/`). `pnpm capture:encode` re-runs that step alone.

```sh
pnpm build                      # from the repo root — a stale build reads as a live bug
pnpm --filter realm-site capture:product
```

Nothing it runs is billed and nothing reaches GitHub: Claude and Codex are the scripted agent
(`REALM_FAKE_STANDS_IN`), so the chips still name the models a real session runs, and Code review
reads the fixture pull requests through a fake `gh`. `REALM_CAPTURE_SERVER_PORT`,
`REALM_CAPTURE_CDP_PORT` and `REALM_CAPTURE_SCRATCH` move its ports and its scratch home;
`REALM_CAPTURE_ONLY` runs a subset, for diagnosis.

Scenes are independent and each is wrapped: a selector that has moved loses one image and prints
why, rather than ending the run. The names that survived are written to
`public/product/manifest.json`, and `/features` renders the intersection of that and the copy in
`content/features.ts` — so a broken scene drops out of the carousel instead of shipping a hole, and
a captured scene with no copy authored for it simply is not shown.

Four things the script and the pages are careful about, all of which have bitten:

- **Sharpness.** A claim zooms into part of its scene, and a 2× capture zoomed that far drew fewer
  than two image pixels per CSS pixel on a Retina screen. Next's optimiser made it worse: it served
  every capture as lossy WebP at quality 75 with the colour at half resolution, which smears small
  text. So the window is shot at 3×, each claim is cut from that by `lib/frames.ts` (the same
  arithmetic the page lays it out with), and the pages serve the files as written, never through
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
the doorway's floor, jamb and back. The landing page's field (`lib/dimension/`) assembles and tiles
exactly those faces, drawn flat like the logo: the walls in the three blues, and the doorway's parts
as pieces of empty space that each cut their part of the doorway out of the right wall as they land.
The footer's mark is the same flat mark. Separately, `lib/realm-liquid-glass.ts` bakes the same mark's walls into a signed distance field and refracts
Realm-blue, white and silver light streams through it, and `components/RealmCanvas.tsx` runs it —
pausing offscreen and in a hidden tab, one frozen frame under reduced motion, the vector mark where
WebGPU is unavailable. No page mounts it now: the landing page leads with a capture of the product,
and the mark sits in the lockup, where a shader would draw a smudge.

# realm-site

The marketing site for Realm — Next.js 16 and Tailwind 4, over real captures of the app.

Three routes and nothing else:

| Route | What it is |
| --- | --- |
| `/` | The claim and the capture that is evidence for it, then one claim per section, each with its own capture, the questions, and the download. |
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
scheduled tasks and a run, a Library — and screenshots a list of scenes at 1440×900 and 2× density
into `public/product/`, with the crops the changelog's figures import in `public/product/details/`.

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

Three things the script is careful about, all of which have bitten:

- **The computer name.** Every shot walks its text nodes and replaces the developer's machine name,
  and the scratch home's path, before capturing. It is not enough to do it once during staging —
  each composer redraws it.
- **The display.** The window renders in sRGB (`--force-color-profile=srgb`). Left to the display, a
  capture carries that display's own profile, and the same scene came out vivid from an external
  screen and washed out from the Mac's P3 panel.
- **The browser pane.** There is deliberately no browser scene: the pane is a native
  `WebContentsView`, and a renderer screenshot cannot see its pixels.

## The mark, and the glass

`public/realm-mark.svg` is `resources/icon-src/mark.svg` — the cube with a lit doorway, written by
`resources/icon-src/render.mjs` from `mark.mjs` — and the header draws it beside the name. The
favicons (`app/icon.png`, `app/apple-icon.png`) and `public/app-icon.png` are the app icon drawn from
`resources/icon-src/icons.mjs`; the share images come from `/share` (`pnpm capture:share`).

`lib/realm-liquid-glass.ts` bakes the same mark's faces into a signed distance field and refracts
Realm-blue, white and silver light streams through it, and `components/RealmCanvas.tsx` runs it —
pausing offscreen and in a hidden tab, one frozen frame under reduced motion, the vector mark where
WebGPU is unavailable. No page mounts it now: the landing page leads with a capture of the product,
and the mark sits in the lockup, where a shader would draw a smudge.

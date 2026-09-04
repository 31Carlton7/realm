# realm-site

The marketing site and docs for Realm — Next.js 16, Tailwind 4, and a WebGPU hero rendered with
[vgpu](https://vgpu.sh).

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

Every route is statically prerendered, so the deployment is a static build with no serverless
functions.

### Optional environment

| Variable | Effect |
| --- | --- |
| `NEXT_PUBLIC_REPO_URL` | Overrides the GitHub link. The default in `lib/site.ts` points at the repository, which is private today and will 404 for visitors without access. |

## The hero shader

`lib/realm-shader.ts` is the app icon (`resources/icon-src/icon.wgsl`) drawn live and set in motion:
the ring's bright head sweeps round, the hue drifts, and the icon tilts toward the pointer. It holds
the WGSL as a plain string rather than a `.wgsl` module, so the build needs no bundler loader — vgpu
accepts a raw string as shader source. `components/RealmCanvas.tsx`
imports vgpu dynamically (it never enters the initial bundle), stops the frame loop whenever the
canvas scrolls off screen or the tab is hidden, honours `prefers-reduced-motion` by rendering a
single frame, and falls back to the static icon anywhere WebGPU is unavailable.

### Verifying the shader without a browser

`scripts/render-shader.ts` compiles the exact same string through vgpu's Dawn-backed Node entrypoint
and writes PNGs, so a WGSL error or a broken scene shows up without opening a browser. Dawn is a
native postinstall that the site deliberately does not build, so run it from a scratch project that
does:

```sh
mkdir -p /tmp/shader-lab && cd /tmp/shader-lab
printf '{"name":"lab","private":true,"type":"module","pnpm":{"onlyBuiltDependencies":["@vgpu/adapter-node","webgpu"]}}' > package.json
pnpm add vgpu@0.3.1 pngjs --ignore-workspace

ln -s /tmp/shader-lab/node_modules <path-to-realm>/site/scripts/node_modules
cd <path-to-realm>/site/scripts && node --experimental-strip-types render-shader.ts
```

Each frame is reported with a mean/max/coverage line, so an all-black or blown-out render is obvious
from the terminal alone.

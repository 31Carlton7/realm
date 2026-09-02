import type { NextConfig } from "next"

const config: NextConfig = {
  // `site/` is deliberately outside the pnpm workspace globs (`apps/*`, `packages/*`) so a Vercel
  // build installs only the site's dependencies and never touches Electron or node-pty. Pinning the
  // tracing root keeps Next from walking up into the monorepo looking for one.
  outputFileTracingRoot: import.meta.dirname,
  typedRoutes: true,
}

export default config

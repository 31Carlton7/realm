import type { NextConfig } from "next"

const config: NextConfig = {
  // `site/` is deliberately outside the pnpm workspace globs (`apps/*`, `packages/*`) so a Vercel
  // build installs only the site's dependencies and never touches Electron or node-pty. Pinning the
  // tracing root keeps Next from walking up into the monorepo looking for one.
  outputFileTracingRoot: import.meta.dirname,
  typedRoutes: true,
  // iOS reads this to let the Realm app open realm.computer/pair links (Plan 28). It has no extension,
  // so without this it would be served as application/octet-stream.
  async headers() {
    return [
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ]
  },
}

export default config

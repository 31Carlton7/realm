import type { Metadata } from "next"

import { DocPage } from "@/components/DocPage"

export const metadata: Metadata = {
  title: "Packaging & updates",
  description: "How Realm builds a distributable app, and why the updater ships disabled.",
}

export default function PackagingPage() {
  return (
    <DocPage
      title="Packaging & updates"
      lede="Realm packages into a normal macOS app with no system Node required. The auto-updater is wired but deliberately off."
    >
      <h2>Building</h2>
      <pre>
        <code>{`pnpm dist       # full build → DMG + zip in apps/desktop/release/
pnpm dist:dir   # stops at an unpacked Realm.app, for fast iteration`}</code>
      </pre>
      <p>
        Under the hood: the root build, then a staging step that runs a <code>pnpm deploy</code> of
        realm-server with its production <code>node_modules</code>, the bundled <code>skills/</code>, the
        helper and the icon. electron-builder packs that.
      </p>
      <p>
        The server and skills are staged as <strong>real files</strong> under{" "}
        <code>Contents/Resources/</code> rather than inside the asar archive.{" "}
        <code>node-pty</code>&apos;s native prebuilds and a spawnable server entry point cannot load from
        an archive, so putting them there would produce an app that builds cleanly and fails at launch.
      </p>
      <p>
        No system Node is needed at runtime: the packaged app runs realm-server under its own binary
        with <code>ELECTRON_RUN_AS_NODE</code>.
      </p>

      <h2>Unsigned by default</h2>
      <p>
        With no signing credentials in the environment, <code>pnpm dist</code> produces an unsigned,
        un-notarized app and says so. A copy downloaded to another Mac will be quarantined: the first
        launch needs right-click → Open, and on Apple Silicon Gatekeeper may report the app as
        &ldquo;damaged&rdquo;. Clear that with:
      </p>
      <pre>
        <code>xattr -cr /Applications/Realm.app</code>
      </pre>
      <p>
        Locally built copies launch normally. Signing and notarization are fully wired and activated by
        environment variables — with those set, the same <code>pnpm dist</code> signs, notarizes and
        staples with no code changes.
      </p>

      <h2>Why the updater is off</h2>
      <p>
        The app carries auto-update scaffolding, but the gate only ever opens when all of: the app is
        packaged, the build is signed, and the feed flag is flipped.
      </p>
      <blockquote>
        <p>
          The repository is private. electron-updater&apos;s GitHub provider can only read private
          release assets with an API token, and shipping a token inside the app would hand it to every
          user. That is banned, permanently — and updates into an unsigned app could not pass
          Squirrel.Mac&apos;s signature validation anyway.
        </p>
      </blockquote>
      <p>Two conditions activate it:</p>
      <ol>
        <li>
          Releases reachable without credentials — public GitHub releases carrying the DMG, zip and{" "}
          <code>latest-mac.yml</code>, or any static host serving the same files.
        </li>
        <li>Signed and notarized builds.</li>
      </ol>
      <p>
        Then flip the feed flag. Nothing else changes: the Settings row starts offering a real check,
        and quit-and-install already tears the server child down cleanly.
      </p>
    </DocPage>
  )
}

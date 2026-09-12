export type Feature = {
  /** Matches the scene name in `scripts/capture-product.mjs`, and so `public/product/<slug>.png`. */
  slug: string
  title: string
  blurb: string
}

/**
 * The carousel, in tour order: the workspace first, then what lives in it, then what configures it.
 *
 * Copy is authored here; the images are captured. `capture-product.mjs` writes a manifest of the
 * scenes that actually succeeded and the page renders the intersection, so a scene that breaks drops
 * out rather than shipping a hole.
 *
 * Some captured scenes are deliberately absent. `notifications` is two rows on an empty page, and
 * `permissions` leads with two development-build caveats that are true of the capture and not of a
 * packaged Realm — both would be worse evidence than none.
 *
 * `rewind` goes the other way: the copy is here, and the scene only produces an image when the
 * checkpoint it opens really can rewind the conversation. The capture's own agent is scripted and
 * records no provider cursor, so that checkpoint honestly says "Files only" — and the scene fails
 * rather than shoot it. The slide appears when the capture is run against a session that rewinds.
 */
export const features: Feature[] = [
  {
    slug: "sidebar",
    title: "An Arc-style sidebar, and nothing else that navigates",
    blurb:
      "One column: search, the destinations every space shares, then the space you are in — its open panes above everything it holds. A strip of the other spaces sits along the bottom, and swiping between them tracks the trackpad the way macOS Spaces does.",
  },
  {
    slug: "profiles",
    title: "Spaces, under the profile they belong to",
    blurb:
      "A space is one body of work: its sessions, files, connections and memory. A profile is the layer above — Personal and Client work keep separate spaces, and what you put on the profile is seen by every space under it.",
  },
  {
    slug: "activity",
    title: "Every chat, by the day you last worked on it",
    blurb:
      "The sidebar's activity lens lists every chat across the profile's spaces, grouped by the day it was last worked on. Each row carries the space, the folder and the branch that tell two similarly-titled chats apart.",
  },
  {
    slug: "workspace",
    title: "Several kinds of work, one grid",
    blurb:
      "Sessions, documents, terminals and pages share one pane grammar and one saved layout. What you leave open is what you come back to.",
  },
  {
    slug: "session",
    title: "A transcript you can read",
    blurb:
      "A plan gets a card rather than a paragraph, a tool call gets the shape of what it did, and the list of what is left stays pinned above the composer while the run scrolls past it.",
  },
  {
    slug: "rewind",
    title: "A restore that takes the conversation back with it",
    blurb:
      "Restoring a checkpoint used to put the files back while the agent still remembered writing them. For a Claude session it now cuts the transcript back and resumes the provider conversation at the same turn. Every other agent says plainly that it cannot.",
  },
  {
    slug: "models",
    title: "Every model, one picker",
    blurb:
      "Claude, Codex, Cursor, Gemini, Grok, Kimi and GLM — with what each costs, how much context it holds, and which harness will actually run it.",
  },
  {
    slug: "palette",
    title: "⌘K reaches everything",
    blurb:
      "Sessions across every space, panes, layouts, palettes and each destination, ordered by recency and honest about what it cannot open.",
  },
  {
    slug: "documents",
    title: "Documents beside the run",
    blurb:
      "Markdown, PDFs, study guides and Office files open in a pane, in rich or source mode — and an agent reads the same folder you do.",
  },
  {
    slug: "editor",
    title: "Source in a pane, and search over the checkout",
    blurb:
      "Code opens in CodeMirror in the documents pane, in the app's own theme, with find, replace and undo. ⌘P finds a file by name across the checkout; ⌘⇧P searches its contents through git grep, which honours .gitignore and still finds the file written ten seconds ago and never committed.",
  },
  {
    slug: "terminal",
    title: "Terminals in the same grid",
    blurb:
      "A real pty in a pane, named for its working directory, respawned where you left it after a relaunch.",
  },
  {
    slug: "commands",
    title: "The commands a space owns",
    blurb:
      "A script is a named shell line — pnpm test — kept with the space and started in a terminal beside your sessions, addressable as script.<id>.run so a key can be bound to it. A slash command is a markdown file with front matter, read from the space, from ~/Realm and read-only from ~/.claude, whose arguments expand into the draft.",
  },
  {
    slug: "library",
    title: "The skills already on your machine",
    blurb:
      "Realm finds them, says where each one came from, and switches them per space. It injects them per invocation and never writes to your CLI's own config.",
  },
  {
    slug: "connections",
    title: "One gateway, and the agent never gets the key",
    blurb:
      "MCP servers are configured once and reached through Realm, so there is one call log instead of one per harness — and Realm's own tools sit on the same switch.",
  },
  {
    slug: "sandbox",
    title: "A sandbox the agent and its terminals run inside",
    blurb:
      "A Seatbelt policy applied when Realm starts an agent CLI or a shell: the space's checkouts and the toolchain caches are writable, $HOME is not, and ~/.ssh, ~/.aws and ~/Library/Keychains cannot be read. It ships off, per space — and a Codex session in a sandboxed space refuses to start rather than running unprotected.",
  },
  {
    slug: "schedules",
    title: "Runs on a clock",
    blurb:
      "A prompt, a workspace and a cadence. It produces an ordinary session with an ordinary transcript, readable afterwards like any run you started yourself.",
  },
  {
    slug: "usage",
    title: "What it actually cost",
    blurb:
      "Spend and tokens by model and by day, a monthly ceiling with an alert before you reach it, and a year of the days you used Realm.",
  },
  {
    slug: "appearance",
    title: "Seven palettes, seventeen faces",
    blurb:
      "Light and dark chosen separately, per-colour overrides that run through the same derivation, a contrast control, and fonts the app can really deliver.",
  },
  {
    slug: "keys",
    title: "The keymap is a file you own",
    blurb:
      "Rules of key, command and when, read from ~/Realm/keybindings.json. The last match wins, so a rule you write beats the default it lands on — and every shortcut the app prints reads the same list the handler does, so a rebind moves the hint with it.",
  },
  {
    slug: "engines",
    title: "Every CLI, checked and current",
    blurb:
      "Where each one came from, whether a newer version exists, and the install command offered before the button that runs it.",
  },
  {
    slug: "memory",
    title: "Scope that follows the work",
    blurb:
      "Skills, connections and memory can sit on one space or on the profile above it, where every space underneath sees them.",
  },
  {
    slug: "spaces",
    title: "A space is one body of work",
    blurb:
      "Its name, colour, checkout, sessions and scheduled tasks in one place — and deleting it names exactly what goes with it.",
  },
]

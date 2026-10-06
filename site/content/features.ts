export type Feature = {
  /** Matches the scene name in `scripts/capture-product.mjs`, and so `public/product/<slug>.png`. */
  slug: string
  title: string
  blurb: string
}

/**
 * The carousel, in tour order: the window first, then working with an agent, then the pages and
 * tools around it, then what configures it.
 *
 * Copy is authored here; the images are captured. `capture-product.mjs` writes a manifest of the
 * scenes that actually succeeded and the page renders the intersection, so a scene that breaks drops
 * out rather than shipping a hole. Every blurb describes what is in its frame — re-read it whenever
 * the capture is retaken.
 */
export const features: Feature[] = [
  {
    slug: "sidebar",
    title: "Every space in one sidebar",
    blurb:
      "Each space is a section of one list: its name in its colour, a tally of what is waiting and working in it, and its sessions. Needs you heads the column with every session waiting on a permission or a question, from every space and every profile.",
  },
  {
    slug: "workspace",
    title: "What a session opens, beside it",
    blurb:
      "A file the agent names opens in the side panel at the line it named. A browser, a device, a document or a terminal an agent opens arrives there as a tab, rather than as a column of its own beside whatever had focus.",
  },
  {
    slug: "splits",
    title: "As many panes as there is room for",
    blurb:
      "Split right or down, from whichever spaces the sessions are in. The only limit is room — a pane is never drawn narrower than a session works at — and beside the panes one full-height side panel holds every on-screen session's tabs.",
  },
  {
    slug: "session",
    title: "A transcript that says what each turn changed",
    blurb:
      "A file the agent names becomes a link, and a turn that edited files ends with a card: each file with its counts as git measured them, Review for that turn's diff, and Undo where a checkpoint takes back exactly that turn. A tick down the left edge marks every prompt.",
  },
  {
    slug: "models",
    title: "One short list, with effort and fast mode at its foot",
    blurb:
      "Models grouped by the harness a click runs them through, with what the highlighted one is for, its context and its price. The foot is that model's own effort levels on a track, and the bolt for fast mode; at XHigh and Max the track lights.",
  },
  {
    slug: "questions",
    title: "Every agent's questions on one card",
    blurb:
      "The card says who is asking, and what it offers comes from Realm rather than from the asker: options, with pictures as tiles; text, masked when it is a secret; a model for each step; a file, a branch, a date. 1 to 9 pick an option.",
  },
  {
    slug: "blocks",
    title: "Charts, diagrams and comparisons in a reply",
    blurb:
      "An agent writes a Mermaid diagram, a realm-chart or a realm-compare as fenced code, and the transcript draws it once the fence closes, in Realm's own palette. A body that does not parse stays code, with the reason, and nothing in a block fetches anything.",
  },
  {
    slug: "delegation",
    title: "Hand work to other models",
    blurb:
      "Pick models in the session's Agents tab and say what to build, or ask in words. The session's own agent splits the work and starts a sub-agent on each model; the tab says where each one stands, and the transcript gives each a quiet line of its own.",
  },
  {
    slug: "review",
    title: "Pull requests, read and reviewed in Realm",
    blurb:
      "Code review lists your pull requests through your own gh, so Realm holds no GitHub token. A reviewer runs read-only on the model you choose and leaves its findings on the page, and nothing reaches GitHub until you press Submit review.",
  },
  {
    slug: "schedules",
    title: "Scheduled tasks, and every run a session",
    blurb:
      "A column of tasks, each with the model it runs on and its runs under it. A run is its real session — the transcript, and a prompter to carry it on — beside the task's card: when it repeats, when it runs next, and Run now, Pause, Edit and Delete.",
  },
  {
    slug: "library",
    title: "A Library of your files, sorted by kind",
    blurb:
      "Tabs for images, documents, code and data, and every file one square tile, a picture filling its own. Add, or a drop anywhere on the page, brings your own files in as Realm's copy; Remove from Library takes one back out, with Undo.",
  },
  {
    slug: "documents",
    title: "The Documents pane opens on your files",
    blurb:
      "What this session made and was given, then the Library's, under one search that also finds the checkout's own files by name. ⌘P puts the keyboard there from anywhere, and New makes a document, a spreadsheet, a deck, a paper or a code file.",
  },
  {
    slug: "terminal",
    title: "A terminal's tab says what is running in it",
    blurb:
      "The tab names the program in the foreground before the folder, and wears its mark — git here, or vim, node, or an agent's own. Terminals draw in Realm's own sixteen colours, tuned to each theme.",
  },
  {
    slug: "memory",
    title: "Memory is the document itself",
    blurb:
      "Write and Preview at reading size, saved by a pause in typing. The profile's own document comes first, and every new Claude and Codex session in a space reads that space's before it starts.",
  },
  {
    slug: "connections",
    title: "One gateway, and the agent never gets the key",
    blurb:
      "MCP servers are configured once and reached through Realm, so there is one call log instead of one per harness — and Realm's own tools sit on the same switch.",
  },
  {
    slug: "palette",
    title: "⌘K reaches everything",
    blurb:
      "What is open, then every space's sessions by when they last moved, the pages and the commands — the sessions of a space you are not in included.",
  },
  {
    slug: "onboarding",
    title: "First run, signed in without a terminal",
    blurb:
      "One page: choose your agent — Claude and Codex as cards that install and sign in right there, the rest folded behind one line — then name your space, and start.",
  },
  {
    slug: "new-space",
    title: "New space asks what the space is",
    blurb:
      "A name, an icon and its colours, then one card of the rest: a folder, the profile, and the memory every session there reads before it starts. Create lands you in a session in it.",
  },
  {
    slug: "profiles",
    title: "Profiles keep their sign-ins to themselves",
    blurb:
      "Personal and Client work keep separate spaces, cookie jars, saved sign-ins and passkeys. The switcher says what waits in each, and opens a profile in a window of its own.",
  },
  {
    slug: "activity",
    title: "Every session, by when it last moved",
    blurb:
      "The activity button beside the Spaces caption lists the same sessions by when they last moved, across every space, until you press it again.",
  },
  {
    slug: "appearance",
    title: "Nine icons for the Dock, and type on one scale",
    blurb:
      "Settings ▸ Appearance puts any of nine app icons on the Dock at once, and sets the UI and code text sizes without zooming the layout, the content font, the cursor and the translucency of the sidebar and the panes.",
  },
  {
    slug: "keys",
    title: "The keymap is a file you own",
    blurb:
      "Rules of key, command and when, read from ~/Realm/keybindings.json. The last match wins, so a rule you write beats the default it lands on — and every shortcut the app prints reads the same list the handler does, the menu bar's included.",
  },
  {
    slug: "sandbox",
    title: "A sandbox the agent and its terminals run inside",
    blurb:
      "A Seatbelt policy applied when Realm starts an agent CLI or a shell: the space's checkouts and the toolchain caches are writable, $HOME is not, and ~/.ssh, ~/.aws and ~/Library/Keychains cannot be read. It ships off, per space.",
  },
  {
    slug: "commands",
    title: "The commands a space owns",
    blurb:
      "A script is a named shell line — pnpm test — kept with the space and started in a terminal beside your sessions, addressable as script.<id>.run so a key can be bound to it.",
  },
]

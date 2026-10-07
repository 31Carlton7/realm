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
      "Each space gets a section of one list with its name in its colour, a count of what's waiting and working, and its sessions. Needs you sits at the top with every session waiting on a permission or a question, from every space and every profile.",
  },
  {
    slug: "workspace",
    title: "What a session opens, right beside it",
    blurb:
      "When the agent names a file, it opens in the side panel at that line. A browser, a device, a document or a terminal the agent opens shows up there as a tab, instead of a new column squeezed in next to whatever had focus.",
  },
  {
    slug: "splits",
    title: "As many panes as fit",
    blurb:
      "Split right or down, with sessions from any space. The only limit is room, since a pane never gets narrower than a session can work in. Next to the panes, one full-height side panel holds the tabs of every session on screen.",
  },
  {
    slug: "session",
    title: "A transcript that says what each turn changed",
    blurb:
      "File names the agent mentions become links. A turn that edited files ends with a card listing each file and its line counts from git, with Review for that turn's diff and Undo when a checkpoint can take back exactly that turn. A tick down the left edge marks every prompt.",
  },
  {
    slug: "models",
    title: "One short list, with effort and fast mode at the bottom",
    blurb:
      "Models are grouped by the harness that runs them, with what the highlighted one is good for, its context and its price. At the bottom are that model's effort levels on a track and the bolt for fast mode. At XHigh and Max the track lights up.",
  },
  {
    slug: "questions",
    title: "Every agent's questions on one card",
    blurb:
      "The card says who's asking, and the ways to answer are Realm's own rather than the agent's: options (with pictures as tiles), text that's masked when it's a secret, a model for each step, a file, a branch or a date. Press 1 to 9 to pick an option.",
  },
  {
    slug: "blocks",
    title: "Charts, diagrams and comparisons in a reply",
    blurb:
      "An agent writes a Mermaid diagram, a realm-chart or a realm-compare as a fenced code block, and the transcript draws it in Realm's palette once the block closes. If it doesn't parse, it stays code and tells you why. Nothing in a block fetches anything.",
  },
  {
    slug: "delegation",
    title: "Hand work to other models",
    blurb:
      "Pick models in the session's Agents tab and say what to build, or just ask in words. The session's agent splits up the work and starts a sub-agent on each model. The tab shows where each one stands, and the transcript gives each one a quiet line of its own.",
  },
  {
    slug: "review",
    title: "Pull requests, read and reviewed in Realm",
    blurb:
      "Code review lists your pull requests through your own gh, so Realm never holds a GitHub token. A reviewer reads the diff in read-only mode on the model you choose and leaves its findings on the page. Nothing reaches GitHub until you press Submit review.",
  },
  {
    slug: "schedules",
    title: "Scheduled tasks, where every run is a session",
    blurb:
      "A column of tasks, each with the model it runs on and its runs underneath. A run is a real session, with the transcript and a prompter to keep going. Next to it is the task's card: when it repeats, when it runs next, and Run now, Pause, Edit and Delete.",
  },
  {
    slug: "library",
    title: "A Library of your files, sorted by kind",
    blurb:
      "Tabs for images, documents, code and data, with every file as a square tile. Add files, or drop them anywhere on the page, and Realm keeps its own copy. Remove from Library takes one back out, and you can undo it.",
  },
  {
    slug: "documents",
    title: "The Documents pane opens on your files",
    blurb:
      "First what this session made and was given, then the Library, all under one search that also finds files in the checkout by name. ⌘P jumps to that search from anywhere, and New makes a document, a spreadsheet, a deck, a paper or a code file.",
  },
  {
    slug: "terminal",
    title: "A terminal's tab says what's running in it",
    blurb:
      "The tab names the program in the foreground before the folder and shows its icon: vim here, or git, node, or an agent's own mark. Terminals use Realm's own sixteen colours, tuned for each theme.",
  },
  {
    slug: "memory",
    title: "Memory is just the document",
    blurb:
      "Write and Preview at reading size, and it saves when you pause typing. The profile's document comes first, and every new Claude and Codex session in a space reads that space's memory before it starts.",
  },
  {
    slug: "connections",
    title: "One gateway, and the agent never gets the key",
    blurb:
      "You set up MCP servers once and every agent reaches them through Realm, so there's one call log instead of one per harness. Realm's own tools are switched on and off in the same place.",
  },
  {
    slug: "palette",
    title: "⌘K reaches everything",
    blurb:
      "What's open, then every space's sessions by when they last moved, then the pages and the commands. Sessions from the spaces you aren't looking at are in there too.",
  },
  {
    slug: "onboarding",
    title: "First run, signed in without a terminal",
    blurb:
      "One page. Pick your agent (Claude and Codex are cards that install and sign in right there, and the rest are one click further), name your space, and start.",
  },
  {
    slug: "new-space",
    title: "New space asks what the space is for",
    blurb:
      "A name, an icon and its colours, then one card for the rest: a folder, the profile, and the memory every session there reads before it starts. Create drops you into a session in the new space.",
  },
  {
    slug: "profiles",
    title: "Profiles keep their sign-ins to themselves",
    blurb:
      "Personal and Client work each get their own spaces, cookies, saved sign-ins and passkeys. The switcher shows what's waiting in each one and can open a profile in its own window.",
  },
  {
    slug: "activity",
    title: "Every session, by when it last moved",
    blurb:
      "The activity button next to the Spaces caption lists the same sessions by when they last moved, across every space, until you press it again.",
  },
  {
    slug: "appearance",
    title: "Nine Dock icons, and type on one scale",
    blurb:
      "Settings ▸ Appearance can put any of nine app icons on the Dock right away. It also sets the UI and code text sizes without zooming the layout, the font for messages and documents, the cursor, and how see-through the sidebar and panes are.",
  },
  {
    slug: "keys",
    title: "The keymap is a file you own",
    blurb:
      "Rules of key, command and when, read from ~/Realm/keybindings.json. The last match wins, so a rule you write beats the default it overlaps. Every shortcut the app shows, the menu bar's included, reads the same list the handler does.",
  },
  {
    slug: "sandbox",
    title: "A sandbox the agent and its terminals run inside",
    blurb:
      "A Seatbelt policy applied when Realm starts an agent CLI or a shell. The space's checkouts and toolchain caches are writable, $HOME isn't, and ~/.ssh, ~/.aws and ~/Library/Keychains can't be read. It's off by default, per space.",
  },
  {
    slug: "commands",
    title: "The commands a space owns",
    blurb:
      "A script is a named shell line like pnpm test, kept with the space and run in a terminal next to your sessions. Each one is addressable as script.<id>.run, so you can bind a key to it.",
  },
]

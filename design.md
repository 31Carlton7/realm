---
name: realm-design-guidelines
description: "Design, build, or substantially revise Realm product UI, documentation, or marketing surfaces. Use this for layout, typography, color, controls, panes, navigation, screenshots, motion, responsive behavior, and interface copy that must feel like Realm."
---

# Design interfaces like Realm

Realm is a local-first Mac workspace for running coding agents. Its interface should feel like a
quiet, capable desktop instrument: dense enough for real work, calm enough to keep open all day, and
clear about what is local, what is running, and what will change.

This file carries design judgment. Exact mechanics live in the product tokens and components. Do not
turn this file into a second stylesheet or copy values from it when the code already exposes a token.

## Start with the work

Before choosing components, identify:

- What is the person trying to run, inspect, compare, or hand off?
- Which object is primary: a session, terminal, browser, document, diff, setting, or space?
- What state could change the next action: running, waiting, blocked, dirty, saved, disconnected?
- What should remain visible while the primary work happens?
- What must be recoverable after a relaunch?

Put the working object first. Navigation, controls, context, and explanation support it. They do not
compete with it.

Use this priority when requirements conflict:

1. Preserve user work, state, and truthful system behavior.
2. Keep the next action and its consequence unambiguous.
3. Preserve the current workspace and pane context.
4. Reuse Realm tokens, primitives, interaction patterns, and language.
5. Refine composition, responsive behavior, and visual detail.

## Product character

Realm is:

- **Local and legible.** Show where work runs and where files live when that knowledge matters.
- **Spatial.** Spaces and panes are the mental model. Let adjacent work stay adjacent.
- **Agent-neutral.** Providers have identity, but the workspace is the product.
- **Quietly technical.** Use exact terms and useful state. Avoid theater about AI.
- **Durable.** Persisted layouts, transcripts, documents, and checkpoints should feel dependable.
- **Mac-native, not ornamental.** Respect platform geometry, focus, menus, and density without
  imitating Finder chrome or adding decorative translucency.

The memorable Realm move is the workspace itself: several kinds of work share one pane grammar and
one saved spatial context.

## Source of truth

Inspect the existing implementation before designing.

- Product tokens: `apps/desktop/src/renderer/src/theme/tokens.css`
- Product component skin and layout: `apps/desktop/src/renderer/src/styles.css`
- Shared theme derivation: `packages/ui/src/theme.ts` and `packages/ui/src/themes.ts`
- Marketing tokens and prose styles: `site/app/globals.css`
- App icon and landing shader: `resources/icon-src/` and `site/lib/realm-liquid-glass.ts`

When the landing mark is presented as glass, derive its surface field from the approved vector rather
than inventing geometry around it. Refraction and edge highlights must respond to that field, and
light should converge and bend through the form rather than appearing as a decorative line laid over
it. Keep the illumination within Realm's neutral palette and blue accent.

Reuse the host surface's existing styling system. The desktop app uses its CSS tokens and classes;
the site uses Tailwind backed by Realm variables. Do not introduce a parallel component theme.

## Composition

Treat a Realm screen as a field of work, not a stack of cards.

- Give each view one dominant working object.
- Align pane bars, toolbars, lists, editors, and sidebars to shared edges and baselines.
- A row whose items compete for width needs a stated yielding ORDER, not proportional shrinking.
  Decide which item is user data of unbounded length, give that one the slack and take it back
  first, and reserve the fixed width of everything beside it explicitly. Left to the layout, the
  item with a cap takes its cap and its neighbours absorb the shortfall — which is how a
  four-letter space name ends up ellipsized to "L." beside a branch that had room to spare.
  Fixed BOILERPLATE in the same element as the unbounded item is the same failure wearing prose:
  "Made in " is eight characters that take their width before the session title gets any, and on a
  card that narrow it is the whole difference between a name and an ellipsis. Give the sentence to
  the accessible name and the tooltip, where a string that reads identically on every row belongs,
  and let the screen carry a glyph and the part that varies.
- Use the full useful width for work that benefits from it: diffs, terminals, documents, sheets,
  usage tables, and comparisons.
- Keep persistent navigation narrow and stable. Do not make the sidebar the loudest surface.
- Preserve source order as reading order. A visual split must still read sensibly when stacked.
- Use empty space to isolate a focal object, not to make sparse content look premium.
- Repetition is for true peers. If one object is decisive, give it different scale or placement.
- A panel is as tall as its content, capped at the space it is docked to, and scrolls only past that
  cap. Taking the container's height outright is not a layout decision, it is the absence of one:
  the session summary drew a column of empty surface the height of the window behind three short
  rows. Empty ground beside a small card reads as air; empty surface inside a card reads as a claim
  on room it had nothing to put in. The dissolve at the scroller's edge follows the same rule — it
  appears when something is genuinely under it, so a list that fits wears no band at all.

The first viewport of a page that EXPLAINS must show the product or its central working relationship.
Do not spend it on mood alone.

A page that only routes is not that page. Realm's landing page is one screen — the mark, the name,
the download, and the two links out — and it deliberately shows no product at all, because it makes
no argument that a screenshot would have to support. The exception holds only while the page stays
that small: the moment it starts claiming things, it owes evidence, and the rule above applies
again.

## Surfaces and depth

Realm is dark-first. The base palette is a cool neutral ladder:

- `--page`: window and sidebar ground
- `--canvas`: the working plane
- `--surface`: cards, menus, sheets, composer, and other raised objects
- `--inset`: wells and recessed controls
- `--hover` and `--hover-2`: interaction states
- `--ink`, `--ink-2`, `--ink-3`: primary, secondary, and quiet text
- `--accent`, `--accent-ink`, `--accent-tint`: focus and active state

Rules:

- Let large work areas rest on `canvas`. Do not wrap every section in a surface.
- Use surface contrast before adding a border.
- A hairline earns its place only where content genuinely passes UNDER a fixed edge. A bar that
  is a flex sibling above a scroller is not that — the scroller clips at its own edge and
  nothing ever crosses the line. The test is mechanical: is the element sticky or absolutely
  positioned over the thing it is ruling? If not, the rule is decoration, however reasonable
  the story told about it. Chrome above content may take a seam; chrome above more chrome may
  not, and two stacked seams in the same 60px is the failure this rule exists to catch.
- Hairlines separate structure. Shadows indicate elevation. Resting objects do not cast shadows.
- A hairline with NO change of surface beside it needs its own weight, and its own token. The
  ordinary line is sized for the ordinary case, where a surface step carries most of the boundary
  and the line only sharpens it. Where both sides are the same ground the line is the whole
  boundary: the pane divider on `--line` measured 6.6% of full range in dark and 5.2% in light, and
  panes read as one wash — reported as dividers that "disappear". Two tells that this is what you
  are looking at: the surfaces either side resolve to the same token, and the reliable way to see
  the line is to put the pointer on it, which is the hover state doing the resting state's job.
- Do not assume the light face mirrors the dark one. Black on a near-white ground loses more of
  itself than white on a near-black ground, so the same step down the alpha ladder lands weaker in
  light — the divider needed a heavier step there to reach the same reading. A per-mode value that
  looks inconsistent in the token file may be the only consistent thing on screen.
- A native view is not on the same plane as the interface. A `WebContentsView` composites ABOVE the
  window's DOM unconditionally, so anything the renderer draws beside one — a divider, a ring, a
  focus outline — loses to it and cannot win back. Give such a view bounds INSET to the pixel grid,
  never rounded to it: an edge rounded outward covers the pixel next door, and the pixel next door
  is usually the only boundary the layout has. Losing a hairline of page content at the edge is
  invisible; losing a divider is not.
- Contrast claims about a hairline are pixel measurements, not stylesheet readings. What `8% white`
  comes to depends on the ground it lands on, and no amount of reading the CSS will tell you. Take
  the mean luminance either side of the line and the line itself, in both faces, with the line
  removed as the mutant. `pane-divider-live.mjs` and `sidebar-edge-live.mjs` are the pattern.
  Know what the capture cannot see: a CDP screenshot renders the DOM only, so a native view over the
  surface under test is simply absent from it and every reading comes back clean. When a native view
  is in play the evidence is a real screen capture or an argument about the geometry, not a
  `Page.captureScreenshot`.
- A ring is one stroke on one curve. A hairline traced INSIDE a clip that rounds the same corner —
  an inward outline on an `overflow: hidden` group — is two anti-aliased edges half a pixel apart,
  and every corner of the permission chip group rendered as a thick dark arc. Draw the ring on an
  overlay that carries the corner itself, and give it to the segment rather than the group, because
  the ring is also a per-segment decision: a segment that is FILLED (Full access, Ask, Plan) wears
  no ring on its side. The fill already says "control" there, and a hairline over a tint reads as a
  second, disagreeing edge.
- Floating menus, palettes, sheets, composers, and overlays use the established layered shadow
  stacks. Never invent a single heavy drop shadow.
- The blue accent is a condiment: focus, selection, progress, links, and primary actions. It is not a
  background wash.
- A chip drawn on a RAISED surface may not take its fill from the neutral ladder. One step off the
  ground it sits on is a step nobody can see — the sent element chip was `inset` on `raised`, which
  measures 1.05:1, so the chip existed only as text with a smudge behind it. A tint is what separates
  a named thing from the prose around it, and it has to hold on both faces.
- Green, orange, and red communicate state. Never use them as decorative brand colors.
- Images and screenshots get a one-device-pixel inset outline: pure white at low opacity on dark
  surfaces, pure black at low opacity on light surfaces.
- Never put a backdrop blur over a translucent window surface such as the sidebar. A filter blurs
  the window's own transparency and composites toward black, so the band reads as a dark smudge.
  Dissolve a scrolling edge on such a surface by masking the scroller itself, which paints nothing.
- A dissolve belongs to the SCROLLER, not to the layout band that happens to contain it. A fade
  positioned on a parent that also holds navigation is drawn over that navigation: the settings tab
  strip arrived smeared and half-legible the moment the column under it was scrolled, and at every
  width, because the rail is a column beside the content wide and a row above it narrow. The test is
  the hairline's test again — is the thing under the band content that scrolls past a fixed edge, or
  chrome that stays? Chrome never goes soft.
- Chrome that lives INSIDE a faded scroller outranks the band rather than passing under it. Keeping
  the fade off the layout band only saves the chrome beside the column; a search field and its filter
  chips sit in the column, and a band gated on scroll takes them the moment the list moves — the
  Library's chips arrived as a smudge, which reads as a broken render, not as depth. A backdrop blur
  takes whatever is painted beneath it, so lift the control above the band (the prompter already
  outranks the transcript's for the same reason). It still scrolls away; it just does so legibly.
- A decorative colour wash belongs on a surface a person passes through, such as first run or a
  feed. A page of controls someone sits on all day stays plain.

The light theme is an equal mode, not an inverted dark screenshot. Use its authored token values.

## Shape

Use the existing radius ladder:

- 2 px: ticks, rails, and code marks
- 6 px: chips and compact inline controls
- 8 px: buttons, inputs, and controls
- 12 px: cards, rows, menus, and panels
- 16 px: sheets, palettes, and floating windows
- Pill: statuses or controls whose shape communicates compact continuity

Nested radii must be concentric: outer radius equals inner radius plus the padding between them. Do
not put a 12 px child inside a 12 px parent with a narrow gap.

A corner is a curve plus the flat run beside it, and the run is what the curve is read against. That
is why the superellipse the signature surfaces wear cannot simply be scaled down onto a control: a
36 px corner is a third of the composer's height and has a run to depart from, while a control's
corner is nearly the whole of its short side and has none, so the same exponent leaves nothing on
screen but the squareness. A control therefore rounds the exponent DOWN rather than the radius up —
the radius has nowhere to go, since it may never pass half the short side, and reaching for the last
tenth of a pixel there only turns every control that renders the circular fallback into a pill.
Figma and iOS taper corner smoothing near that same limit for the same reason.

The large composer squircle is a product signature, and its role is broader than the composer. It
belongs on any surface that is a **panel the eye rests in** rather than a row it scans past: the
composer, a fenced code block, a commit or review card, an install card. What it does not belong on
is a routine list row, a menu, a chip, or anything whose job is to be counted rather than read.

Where the signature goes, the hairline ring comes off. A ring traced around a large radius is the
one thing that reliably makes the radius read as a mistake instead of a decision; the surface fill
is what separates the panel from what surrounds it, and it is enough. For the same reason, do not
rule a squircled panel's own head off from its body — a language label and a copy control are chrome
for the panel, not a section beside it.

`corner-shape: squircle` is inert in the Chromium this app ships on, so a surface that declares it
must also be listed in the paint-worklet rule in `styles.css`. A panel that declares the curve
without the paint renders a plain rounded rect next to a composer wearing a real one, which is worse
than not having asked. `styles.test.ts` enforces this — the two can no longer drift.

A list whose rows carry more than one line each is a list of cards, not of rows. Rows separated by
nothing but a line break read as one block of prose, which is what makes a page of them feel like
splattered text however carefully each row is written. Give them air and a surface; do not give them
a rule, which says the same thing twice.

## The type floor

Nothing is set below 11px. The exceptions are geometry or typography, never taste, and each is named
individually in `styles.test.ts` rather than tolerated by a range: a superscript sized against its
own line, and text inside a box whose height is fixed by something other than the text. A 10.5px
uppercase micro-label looks considered on its own; thirty-seven of them are why a page becomes
unreadable.

## Typography

Realm uses Inter for interface and reading text, and JetBrains Mono for code and operational data.
Using the same families across the app and site is a brand decision.

- Interface body: 14/20 in the desktop app.
- Small UI: 13/16; tiny operational labels: 11/14.
- Product titles: 18, 20, 24, or 28 with the shared title weight and tracking.
- Marketing body: at least 16 px with a 1.5–1.6 line-height.
- Marketing display type may scale fluidly, but keep one display statement per page.
- Use the named weight ladder. Routine labels are 450–500; titles are 560; strong emphasis is 600.
- Headings balance; descriptions wrap prettily; reading copy stays near 60–75 characters.
- Use tabular numerals for cost, usage, time, progress, and aligned comparisons.
- Use mono only for code, commands, paths, identifiers, branches, models, timestamps, and machine
  state. Mono is not a substitute for a visual hierarchy.
- Set `font-synthesis: none` and use WOFF2 assets or the existing font loader.

Write copy in natural sentence case. Do not type labels in uppercase and then depend on the source
string staying that way.

## Controls and interaction

- Desktop hit areas are at least 40 × 40 px; touch targets are at least 44 × 44 px.
- Primary actions use the accent only when there is a clear primary action.
- Focus is always visible and uses the accent ring.
- Icon-only actions need an accessible name and a tooltip when the meaning is not universal.
- A toggle names its state or carries `aria-pressed`, never both — "Unfocus Two, pressed" is a
  sentence at war with itself. Which one it takes is a fact about the accessible NAME, so it may not
  become a difference in the fill: "this control is on" gets ONE appearance across a bar, or the
  reader learns two of them.
- State the screen has stopped showing belongs on the control that changes it, not on a strip that
  reports it. A focused pane hides its siblings, and the answer to that was a banner across the top
  of the window reading "Focused: <title> | Unfocus" — a whole row of chrome, and a second place to
  look, to carry one bit. A lit toggle in the pane bar says it and undoes it in the same click. Ask
  what the banner is for before building it: if a control could wear the state instead, it should.
- Prefer a familiar symbol from Realm's icon set over a new illustration.
- Align asymmetric icons optically. A mathematically centered arrow or play mark can still look wrong.
- Buttons may scale to `0.96` while pressed. Keep the transition interruptible.
- Never use `transition: all`; list the properties that change.
- A control whose fill is DRAWN rather than declared still has to animate that fill. Naming
  `background-color` on a surface whose background is a paint worklet transitions nothing, and the
  control snaps while its plain neighbours fade — a difference nobody attributes to the corner
  treatment. Transition the property the painter reads, and register that property with a type, or
  it computes to a token stream and token streams do not interpolate.
- Disabled controls keep their label legible and explain the unavailable action when useful.
- A first-run screen is a decision, not an inventory. The onboarding sheet opened on twelve equal
  rows of agents with the one required field and its button below the fold; the inventory had
  buried the decision it was there to inform. Preselect what can be preselected, default what can
  be defaulted (the space's name from the folder's), fold what was merely detected behind one line,
  and keep the primary action outside the scroller so it is live from the first frame. Ask the
  question the user actually arrived with — where the code is — before the ones the product needs.
- A row is a label and its control. A sentence under it has to say something neither of them says:
  what else the switch does, why the control you expected is absent, what a click will execute on
  your machine. A description that restates the row's own state chip — "macOS reports the grant"
  beside a chip reading Granted — or that paraphrases the command printed directly under it is how a
  page of settings becomes an essay, and nine of them under nine switches is most of the reading on
  the page. Everything else is the control's `title`: kept, reachable, and off the screen.
- A control that carries a REQUEST must show what actually happened when the two can differ. A
  switch reading only its own state keeps claiming a thing the system is not doing — and the
  reasons it is not are worth telling apart, because one may resolve itself and another never
  will. Say nothing in the ordinary cases: a note that appears every time is a note nobody
  reads by the third session.
- A list of things reached through several routes lists each thing under EVERY route that offers it.
  The model picker groups by harness; once Cursor's catalog arrived, a Claude model both could run
  resolved to the session's harness alone and vanished from the other heading, so a Cursor session
  showed an empty Claude group and the only way to Fable-through-Claude was to pick it under Cursor
  and change the route afterwards. Deduplicating the OBJECT (one favourite, one catalog entry, one
  tick) is right; deduplicating its PLACEMENTS is what emptied the group. Refine the route in the
  detail pane; do not make the list hide it.
- Offer a capability only where its OWNER has said it exists. A table in the app goes stale,
  and a control offered on a guess is one whose only outcome is a refusal. Where the owner has
  said nothing, show nothing — not a disabled control, which invites a user to work out how to
  enable something nobody has claimed.
- A link is shown as what it points AT. A pasted Slack permalink is ninety characters of nothing
  a person reads; its meaning is "this thread", and the chip says that: the app's mark, then a
  name (a thread's timestamp, an issue key, a page title). Only where Realm can name the link — a
  wrong name on a chip is worse than the URL, which at least says what it is. The agent is sent
  the link itself, as a markdown link, because its connection to that app is what opens it. The
  chip is the SAME chip as a mention or a picked element: an icon and a name in the accent, inline
  with the prose — no fill, no box. The pill read as a control dropped into a sentence. The icon
  is what says which kind of thing it is (a skill's spark, a picked element's target, an app's
  mark), drawn over the token's opening sigil so the painted run keeps every character's width.
  Links in prose are colour and weight, no underline; hover restores it.
- A vendor that issues no client on the fly gets the user's own app, asked for BEFORE the sign-in
  and with the one fact nobody guesses right (the redirect URL) printed in the steps. A Connect that
  fails afterwards with "no client registered" is a door that opens onto a wall. Where the vendor
  also refuses a loopback redirect, the callback goes through the site's HTTPS relay — a closed
  bounce to this Mac, never a redirector — so the vendor sees one stable URL.
- The apps a space connects to are a front door, not a second system: a card per vendor's own
  remote server, one action (Connect), and from then on an ordinary server in the list below with
  the same tools policy and activity. A card names what the connection is FOR in the prompter.
- An object reached from two lists opens ONE way. The same file was a rich viewer from the file
  browser and a bare "hand it to the OS" modal from the session summary, and the difference was
  invisible until someone reached the same thing twice. Share the surface, not just the predicate:
  a list that knows more — where the file came from — adds a row to it, and a list that knows less
  draws that row not at all rather than half-filled.
- Two overlays that both answer Escape answer it in MOUNT order, not stacking order, because both
  listen on the window. The one underneath was registered first and wins, so `stopPropagation` from
  the top surface cannot save it: expanding a picture out of a sheet closed the sheet too. A full
  window overlay should REPLACE what it covers rather than sit on it — the thing underneath is
  invisible anyway, and unmounting it is what takes its key handler with it.
- Destructive actions must name their target and distinguish removing from a layout from deleting the
  underlying object.

Use native menus, fields, and disclosure behavior where they fit. Do not make a custom control for a
styling opportunity.

## Motion

Motion preserves continuity and confirms state. It does not decorate idle work.

- Use transitions for hover, press, selection, resize, open, and close states so they can reverse.
- Use keyframes only for one-shot entrances or ambient states that genuinely need a loop.
- Interactive fills answer quickly; popovers and swaps are short; drawers and spatial moves may take
  longer. Use the duration and easing ladder in `tokens.css`.
- Stagger a composed entrance by semantic parts, not every child.
- Exits are shorter and quieter than entrances.
- Contextual icon swaps use opacity, blur from 4 px to 0, and scale from 0.25 to 1 with no bounce.
- Do not animate content merely because it scrolled into view.
- Do not add parallax, auto-scrolling marquees, simulated typing, or decorative pulsing.
- Respect reduced-motion and reduced-transparency preferences.

## Spaces, panes, and navigation

- A space represents one body of work. Its sessions, files, connections, memory, and pane groups
  should feel related.
- A pane is a location, not decoration. Pane bars stay compact and consistent across pane kinds.
- Splits expose relationships. Avoid a split when one side has no ongoing value.
- Pane focus, selection, zoom, navigation history, and group state must remain visibly distinct.
- Empty panes should offer the shortest honest path to useful work.
- Several agents need one page that answers "what should I look at": every session across every
  space by what it needs from you — blocked on a permission first, then working, failed, finished.
  The per-space badges say the same thing per space; the page says it once, with enough on each
  row (space, folder, model, how long ago it moved) to choose without opening. A relay beyond the
  Mac (a text, a Slack line) carries only those moments a person has to come back for, and one
  open condition is sent once.
- The sidebar answers where the user is and what else is available. Keep primary destinations,
  spaces, open items, and contextual actions visually separate.
- Closing a pane should never imply deleting the object behind it. That rule is about objects that
  outlive their pane — a session's transcript, a diff's checkout — and the × in a pane bar is right
  exactly where one exists. It has no work to do where there is nothing underneath: a destination
  page's `refId` is a sentinel, and a terminal, browser or documents pane is a thing opened at a
  moment and finished with. A × on those closes into a drift of rows in the space that nobody asked
  to keep, and the user reads it as the pane refusing to go away. Give those bars the trash instead,
  and leave the layout-only close on ⌘W and in the ⋯ menu, named so it says which of the two it is.
- A confirm step is owed by the OBJECT, not by the destructive-looking button. A pty, a live web
  view and a document workspace are each something a stray click would cost you, so those arm first;
  a page has nothing under it, and a second click that guards nothing is chrome charged for a
  reassurance it cannot give.

## Agent sessions

- The transcript is content; the composer is the action surface. Keep the transcript visually calm
  and the composer available without obscuring the last message.
- User messages, assistant prose, plans, tool calls, permissions, diffs, and attachments must have
  distinct shapes because they lead to different actions.
- Running, waiting, stopped, and failed states must be readable without color alone.
- Provider, model, mode, workspace, and connector context belong near the composer because they
  change what the next send means.
- Keep raw logs and exhaustive tool detail available without making them compete with the result.
- A closing line names the WORK, not the residue. "This session produced 1 file · 4 attached" is
  true and tells a reader coming back nothing; the ask, the files that changed, whether anything
  ran or failed, and then what came out is the shape of an answer. Derive it from the transcript
  — a fold is free and cannot lie — and say nothing at all for a session that only talked.
- The context an agent works with belongs in one place: folder, branch, model, permission, the
  memory files that actually reach it, the connections it can call. Each is already a chip or a
  pane somewhere; standing them together is what "show me this agent's context" asks for. Draw
  only facts the app holds — a "Branch —" for a folder nobody has asked git about is a claim.
- A note under the composer is for an outcome the user could not otherwise learn, such as a file
  the agent will silently drop. Do not narrate a handoff the agent completes itself; that belongs
  on the chip's tooltip.
- Never invent human-like agent presence, mood, or certainty.

## Documents, diffs, terminals, and data

- Editors and terminals use the available pane. Avoid centered card-width work areas.
- Tabs identify open work; the active document also has a clear title and save state.
- Rich and source modes preserve the same document identity.
- Diffs use color plus signs, line structure, and labels. Color alone never carries add/delete state.
- Tables use their full evidence width. Headers align with representative cells.
- Charts exist only when a relationship is faster to see than read. Direct-label when possible and
  keep exact values available nearby.
- The categorical chart palette is fixed and tested as a set. Never hand-edit one series color.
- A chart over time opens at the PRESENT end. The recent part is what the reader came for, and a
  year-wide graph that starts at its oldest column hides it behind a scroll they may not attempt.
- A sequential scale steps one hue's opacity. Walking a hue across the steps reads as categories,
  which is the opposite of what a single quantity means.
- A file browser's card is a picture over a caption, in that order. The preview field takes the top
  of the card and the name and provenance sit under it, the way a drive lays out files, because a
  screenshot is recognisable at that size and was a smudge beside a name. A file with no picture
  keeps the SAME card: its glyph sits small in a well at the field's centre, so the grid's shape
  does not change from file to file. A field that wide needs a picture minted for it — the 96px
  mark the composer's chips use is a smear there — so the size is named, not assumed.
- A picture of a file earns its place where the picture IS the file. A screenshot, a mockup and a
  frame of video say more than any glyph; a page of source rendered into a 44px square says less
  than the four letters of its extension. The line is also a cost line, and that is not a detail to
  leave to taste: an image decodes in process, and everything else goes out to the platform's
  preview generator — one child process per tile, sixty per page of a grid. A deliberately opened
  preview may ask for anything; a list that scrolls may not.
- Measure what every source can report. A metric only some sources emit becomes a chart of which
  source reports it rather than of the thing it names — and where a figure genuinely cannot be
  stated, draw nothing at all rather than an empty meter, which is itself a claim.

## Marketing and documentation

The site should feel authored by the same team as the app without pretending to be the app.

- Lead with the reader's job and Realm's strongest supported answer.
- Use real product captures as evidence. Stage them in an isolated Realm home, remove personal data,
  keep the viewport fixed, and make capture reproducible.
- A screenshot must demonstrate the adjacent claim. Do not use one as wallpaper.
- Prefer one large legible product view and a few purposeful crops over a mosaic of tiny screens.
- Describe outcomes first, mechanisms second. Preserve qualifiers such as macOS-only, local, or in
  active development.
- Keep a fast path through headings and captions, and a deeper path through docs and architecture.
- End with a concrete next action: install, read the docs, inspect the source, or join development.

Documentation favors direct prose, semantic headings, readable measures, precise code, and quiet
navigation. It does not need marketing drama.

## Language

Realm copy is plain, exact, and compact.

- Say what the object does: “Open in a new pane,” “Move to space,” “Keep mine.”
- Name the consequence before asking for confirmation.
- Prefer “runs on your Mac” to vague privacy language.
- Prefer “the agent never receives the token” to “secure by design.”
- Avoid hype: revolutionary, magical, supercharge, seamless, effortless, game-changing.
- Avoid generic AI imagery and metaphors: copilots, brains, sparkles, robots, glowing orbs.
- Do not narrate the interface or the design process in shipped copy.
- Use periods for sentences, not fragments that only look technical.

## Accessibility and responsive behavior

- Use landmarks, one descriptive `h1`, ordered headings, native controls, visible focus, and accurate
  accessible names.
- Meet WCAG AA contrast. Quiet text is still readable text.
- Do not rely on hover, color, or animation alone.
- Keep inputs at 16 px on mobile to prevent iOS focus zoom.
- Recompose before shrinking. Pane-like imagery may crop deliberately on narrow screens if its focal
  relationship remains visible and the alt text carries the full meaning.
- Give flex and grid children `min-width: 0`. Never conceal broken page overflow globally.
- Test keyboard traversal, 200% zoom, reduced motion, desktop, and a narrow mobile viewport.

## Reject these defaults

Do not ship:

- A centered slogan followed by a generic feature-card grid.
- Purple or blue glow as a substitute for hierarchy.
- Glass cards, decorative blur, or a border around every group.
- Pills for ordinary labels or metadata.
- All-caps tracked eyebrows and decorative section numbers.
- Oversized icons in colored tiles.
- Fake product screenshots or terminal theater presented as the product.
- Tiny gray copy, arbitrary font sizes, or one-off margins that repair weak grouping.
- Several equal-weight calls to action.
- Motion that delays reading or makes a desktop tool feel like a promo reel.
- Claims the current product, docs, or source cannot support.

Restraint is not an empty black page. Realm earns presence through the visible workspace, exact
hierarchy, dense useful detail, and the contrast between quiet chrome and active work.

## Review loop

Render the real result. Review the first viewport, the full flow, a narrow viewport, keyboard focus,
and reduced motion. For product changes, review dark and light modes.

Measure the rendered boxes, not the stylesheet. A rule that says `12px` and a cell that renders at
10 are both true statements — the difference came from the flex or table parent, and only a real
window can be asked about it.

Ask, in order:

1. Is the primary work obvious without reading every label?
2. Is the next action clear, and is its consequence truthful?
3. Does the view preserve the spatial context the user needs?
4. Are type roles, edges, gaps, and peer elements consistent?
5. Can any surface, border, icon, label, or effect be removed without losing meaning?
6. Does every screenshot, chart, or animation carry evidence?
7. Does the implementation reuse tokens and survive responsive and accessibility checks?

Turn repeated corrections into observable rules here, reusable mechanics in the owning CSS or
component, and mechanical failures into tests. Keep the first attempt from fixed scenarios so a
guideline change can be compared against a baseline.

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
  imitating Finder chrome. The window's translucency is platform material, not decoration: it is the
  same `NSVisualEffectView` a Finder or Notes window sits on, it answers Reduce Transparency, and it
  is bounded by what the text on it can survive. Glass laid over an app's own surfaces is the thing
  to refuse.

The memorable Realm move is the workspace itself: several kinds of work share one pane grammar and
one saved spatial context.

## Source of truth

Inspect the existing implementation before designing.

- Product tokens: `apps/desktop/src/renderer/src/theme/tokens.css`
- Product component skin and layout: `apps/desktop/src/renderer/src/styles.css`
- Shared theme derivation: `packages/ui/src/theme.ts` and `packages/ui/src/themes.ts`
- Marketing tokens and prose styles: `site/app/globals.css`
- App icon and landing shader: `resources/icon-src/` and `site/lib/realm-liquid-glass.ts`
- The app icon and its Dock alternates are one vector drawing in nine colourings
  (`resources/icon-src/icons.mjs`): the mark's own geometry on the macOS grid, rendered natively at
  every size. An icon lives in a row of other apps' icons, so it is lit the way the Dock lights
  Apple's — a graded body, a soft edge, one short shadow, a little light from above — and not as a
  render: the generated set's chrome, candy plastic and bright bevel outshone every icon beside it.
  A picture with no source can only be regenerated, never adjusted, which is why the colourings are
  data. A running Mac app can change only its own Dock tile — the Finder keeps the bundle's icon — and
  Settings says so rather than implying more.

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
- A page's head names what it SHOWS — "Sign-ins", "Files" — not the area it belongs to. The pane bar
  and the column already say Settings or Library, and a third copy of that word was the one heading
  on the page that said nothing about what was under it. Each section in the column wears a glyph
  beside its name, as Codex's do, so eleven pages are found by shape before they are read.
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

A page that only routes is not that page, and Realm's landing page was one: the mark, the name, the
download, and the two links out, showing no product because it made no argument a screenshot would
have to support. It makes one now — what the workspace holds, and what an agent is and is not handed
— so it carries what the rule demands: a single capture of a real space, large enough to read, and
captioned with the claim it is evidence for.

The mark went to the lockup when that happened. Two focal objects is the mosaic this section already
refuses, and between an abstract mark and the product, the product is the one that earns the page —
presence here comes from the visible workspace, not from mood. A mark contained to lockup size is
also not a place to run a shader: it draws a smudge, and the static vector reads.

Below that first viewport the page is a SEQUENCE, not a grid: one claim per section, one large
product view each, sides alternating, ending in the questions a reader actually arrives with and one
concrete next action. Alternate with `flex-row-reverse` rather than by reordering the markup, so
source order stays claim-then-evidence and the stacked layout reads the right way round. A claim
whose capture does not exist takes the full measure and reads as prose — a picture of a different
feature under a sentence is worse than no picture, which is why the copy and the capture manifest
are separate lists that the page intersects rather than one list that assumes.

A caption describes what is IN the frame, not what the feature can do. The two drift apart without
anyone lying: the product gains a screen, the capture is retaken, and the sentence above it still
describes the screen from two releases ago. When a capture changes, re-read every word next to it —
"the runs it has already produced" over a picture of two schedules and no runs is a false caption
written by nobody. The same goes for the claim above the picture: state the limit as plainly as the
capability, because a page that only says yes is an advertisement with a different shape.

Crop out anything that is true of the capture harness rather than of Realm. Realm's captures are
staged with a scripted agent whose model chip reads "Fake", and a landing page arguing that you
bring the agent you already use cannot show that word. A crop is only a crop if the frame is
NARROWER than the source — a box set to the source's own aspect ratio crops nothing, and looks
exactly like a crop in the markup.

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
- Edges are quiet. The ordinary line (`--line`, `--line-strong`, `--btn-ring`, `--card-ring`) sits one
  rung below where tembo puts it — 5.1% and 7.1% of full range on the dark panel, 3.9% and 5.6% on the
  light one, measured by `border-softness-live.mjs` — because nearly every one of them runs beside a
  change of surface that already carries the boundary. A window of controls each wearing a bright
  ring reads as outlined rather than as surfaces. A FILL is not an edge: a switch's track, a progress
  track, a scrollbar thumb or an idle dot uses `--mark`, which stays at the old weight, so softening
  the edges can never make a control disappear.
- A hairline earns its place only where content genuinely passes UNDER a fixed edge. A bar that
  is a flex sibling above a scroller is not that — the scroller clips at its own edge and
  nothing ever crosses the line. The test is mechanical: is the element sticky or absolutely
  positioned over the thing it is ruling? If not, the rule is decoration, however reasonable
  the story told about it. Chrome above content may take a seam; chrome above more chrome may
  not, and two stacked seams in the same 60px is the failure this rule exists to catch.
- Hairlines separate structure. Shadows indicate elevation. Resting objects do not cast shadows.
- The window is chrome round a sheet. The rail and the head row across the whole window — the
  traffic lights, the sidebar's head, every pane's top bar — are one ground, a step off the
  sidebar's; the work sits below and beside them in one sheet, under a rim that runs along its top
  and down its left edge and rounds the corner where they meet. Move the CHROME a step, not the
  sheet: the sheet's grounds are the ones the translucency controls are calibrated on. The rim is
  the rung lighter than both sides of it, as Codex's is (chrome 60, sheet 47, rim 65, measured).
  A corner over a translucent ground is a hole in that ground with the chrome laid in it — tinting
  over the ground instead composites twice and reads a shade darker than the rail beside it.
- A group of settings is a card in Codex's grammar: a step ABOVE the ground it stands on, under a rim
  the rung lighter than both sides, its rows divided by hairlines inset from both ends (Codex,
  measured: page 41, card 47, rim 57; its file tiles go further, 16 levels up, because a tile is an
  object you pick up and a card is a group you read). It is not a well. The rows were `--rl-frame`,
  a shade BELOW the page, and a group of controls that reads as a hole in the page reads as nothing
  in particular. The fill is an overlay rather than a colour, because the ground under a page is the
  pane's translucent canvas and the card has to lift whatever that came to. The rim runs round the
  run of rows, not round each one: a row under another hands its top edge to the divider.
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
- What stands in for a page — a new tab, a page on its way, a page that did not load — is the pane's
  own DOM with the view hidden, never a document loaded into the view. The view is opaque, because
  pages assume a white canvas, so anything drawn inside it is a slab of another colour under the
  pane's translucent chrome; the browser pane's "lighter strip" was its host painting the panel tone
  where the view would be. The view comes back once its page has something of its own to show.
- Something that must be SEEN beside a native view moves off it rather than being drawn under it: the
  toast stack slides along the window's foot, a tooltip flips or goes beside its control, and where no
  spot is clear a tooltip goes back to the system's own (macOS draws it above every view) while the view
  under the toasts gives up a strip of its foot, on the pane's ground, for as long as they are up.
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
- A shared component is shared down to its layers, not down to its fill, because a fill is a step
  off the ground under it and the same card stands on different grounds. The file card is
  `--rl-frame` on the Library's canvas; set into the Files dock's raised `--surface`, that one rung
  measured 1.04:1 on the light face — a card with no edge — while dark's read at 1.15. The dock's
  card takes a per-mode pair instead, its light value chosen by measuring until that face's step was
  no weaker than dark's, and the well inside takes the same fill so the ladder within the card reads
  alike on both faces. Share the component; let the ground choose the step.
- Green, orange, and red communicate state. Never use them as decorative brand colors.
- Images and screenshots get a one-device-pixel inset outline: pure white at low opacity on dark
  surfaces, pure black at low opacity on light surfaces.
- Never put a backdrop blur over a translucent window surface. A filter blurs the window's own
  transparency and composites toward black, so the band reads as a dark smudge. Since the panes show
  the window's material too, that now means every surface in the app: a scrolling edge is dissolved
  by masking the SCROLLER, which paints nothing, and what it reveals is whatever was always behind
  the text. A wash to a fixed tone is wrong there for the same reason — it stripes a translucent
  surface with a colour the material shows straight through.
- Translucency is not free and is not uniform. What shows through a pane is the desktop, which nobody
  chose, so the alpha is derived from the type it has to carry rather than picked by eye: the sidebar
  holds labels and goes to 55%, a pane holds the reading and stops where body text would cross WCAG
  AA over the worst desktop. Each has its own control over its own range (`pane-ground.test.ts`): a
  see-through sidebar beside solid reading is a reasonable thing to want, and one control could not say it.
  A claim about what the material does to contrast is a real screen capture, never a CDP screenshot —
  the material is not in the DOM.
- The material is the system's grey, so an alpha is drawn for a palette, not for every palette.
  Realm's own dark ground is a near-grey that reads as itself at 55% over it; a theme with a hue
  mixed 55% into grey reads as grey, and a Rosé Pine sidebar beside Rosé Pine panes stopped looking
  like the theme. A ground the material would wash out — the light face, a hued theme — starts its
  range higher on the same control, so a theme is the theme everywhere it is worn.
- A dissolve belongs to the SCROLLER, not to the layout band that happens to contain it. A fade
  positioned on a parent that also holds navigation is drawn over that navigation: the settings tab
  strip arrived smeared and half-legible the moment the column under it was scrolled, and at every
  width, because the rail is a column beside the content wide and a row above it narrow. The test is
  the hairline's test again — is the thing under the band content that scrolls past a fixed edge, or
  chrome that stays? Chrome never goes soft.
- Chrome that lives INSIDE a scroller dissolves with it, and nothing can lift it out: a mask applies
  to everything the element paints, whatever its stacking order. That is survivable because a mask
  takes alpha rather than detail — a filter bar scrolling into the dissolve keeps its edges and reads
  as a control leaving, where the blur this replaced destroyed them and read as a broken render. So
  chrome that must stay legible while the content moves belongs OUTSIDE the scroller, and a z-index
  on a control inside one is a claim the browser ignores.
- A decorative colour wash belongs on a surface a person passes through, such as a feed — never on a
  page asking someone to decide something, which is why first run stays plain and earns its presence
  from the mark, the type and the two agents' own marks instead. A page of controls someone sits on
  all day stays plain.

The light theme is an equal mode, not an inverted dark screenshot. Use its authored token values.

The window's NATIVE appearance follows Realm's theme setting, not the Mac's. The material behind the
window, and every menu and panel macOS draws for it, take the app's appearance — and Light on a Mac set
to Dark laid a light ground over a dark material, so the whole window came out mid-grey (the sidebar
measured `#a8a8ab` where Codex's measures `#f7f7f7`). `main/appearance.ts` sets it from the preference.
And the light face shows far less of the desktop than the dark one: a wallpaper is almost always
darker and more saturated than near-white paper, so the dark face's alphas read as a grey-blue wash in
light. Judge light mode on a real screen over a dark, saturated wallpaper — a CDP capture has no
material in it and looks fine either way.

Both faces keep ONE depth order: the frame (sidebar, wells) under the canvas, the surface (cards, the
composer, floating things) over it, about one perceptible step each way. Light mode once had its frame
LIGHTER than its canvas, which made the sidebar the brightest region in the window and drew every
well — a tool's output, a settings group — as a bright patch where dark mode draws a recess. The
order is the light ramp in `packages/ui/src/themes.ts`, so every light theme takes it; a light theme's
background is its paper, and the window ground sits a shade under it, which is a Mac sidebar beside
light work and grey grouped boxes on light paper, the way System Settings is built.

Quiet text is text. Every ink tier — hints and timestamps included — and link ink clear 4.5:1 on every
ground they appear on, in both faces. The light hint tier once measured 2.4:1, which was below the
floor this file sets and well under its own dark counterpart; a light face may need different values
from dark to reach the same contrast, and that is a reason to author them, not to accept less.

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

The paint worklet draws a FILL, which is why the signature can only go on a surface whose corner is
made of its own background. A box holding live content that paints itself — a canvas, a video, a
native view — cannot take it: painting goes behind opaque content and changes nothing, and
`mask-image: paint(rl-squircle)` parses in this Chromium without masking (measured against the real
renderer, where the masked box came out square). The answer is not a circular `border-radius`
standing in for the curve next to a composer wearing the real one. It is to round the GROUND the
content is laid into — Realm's surface, which is paintable — and leave the content its own square
edge, with enough padding between the two that the picture never reaches the corner. The machine
pane's screen is the worked example.

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
- Small UI: 13/16; captions and metadata: 12; tiny operational labels: 11/14; transcript reading: 15.
- A page of settings reads at the body: a row's label 14/20, the line under it 13/18, a page's notes
  12.5 — all in the secondary ink. The tertiary ink measures 3.5:1 on the dark ground, under AA at
  those sizes, and a page whose explanations were 11px in it is a page people called hard to read.
  Tertiary is for what a reader may skip (a count, a timestamp), never for what they must read.
- Product titles: 18, 20, 24, or 28 with the shared title weight and tracking.
- Those nine sizes are the whole ladder (`styles.test.ts` holds it), with ONE named exception: a
  settings page's notes at 12.5, which was asked for by name when Settings moved to Codex's grammar
  and is held to its selectors in the test rather than tolerated as a range. A size between two rungs is not a
  finer distinction, it is a mistake a reader cannot name: the app had grown 11, 11.5, 12, 12.5, 13 and
  13.5, so two labels doing one job sat half a pixel apart. The same drift hid a real bug — a code
  rail at 11.5px beside its 12px code drifted a line off by the twenty-fourth. Pick the rung whose
  role matches; columns that must line up share one font string, not two that agree today.
- Marketing body: at least 16 px with a 1.5–1.6 line-height.
- Marketing display type may scale fluidly, but keep one display statement per page.
- Use the named weight ladder. Routine labels are 450–500; titles are 560; strong emphasis is 600.
- The prompter's own text sits a rung up from body, at medium: what is being typed is the thing the
  card exists for. It is set on the editor box, never on one of its two layers, so the painted
  mirror and the caret's textarea cannot disagree about a glyph.
- Headings balance; descriptions wrap prettily; reading copy stays near 60–75 characters.
- Use tabular numerals for cost, usage, time, progress, and aligned comparisons.
- Use mono only for code, commands, paths, identifiers, branches, models, timestamps, and machine
  state. Mono is not a substitute for a visual hierarchy.
- Set `font-synthesis: none` and use WOFF2 assets or the existing font loader.

Write copy in natural sentence case. Do not type labels in uppercase and then depend on the source
string staying that way. A section is named in sentence case at the caption rung, never
in tracked capitals — the transform also disguises what it is fed: an import row printed its raw
`space-folder` enum for months because uppercase made it look like a label. The one exception is an
acronym that is uppercase anyway (a file extension on a tile).

## Controls and interaction

- Desktop hit areas are at least 40 × 40 px; touch targets are at least 44 × 44 px.
- Primary actions use the accent only when there is a clear primary action.
- Focus is always visible and uses the accent ring.
- Icon-only actions need an accessible name and a tooltip when the meaning is not universal.
- A tooltip is the control's `title`, shown by the app's own layer (`tooltips.ts`) a fifth of a second
  after the pointer arrives and at once on the next control — the system's took a second and a half,
  which is a sweep across a toolbar that tells you nothing. Write the title as a plain sentence and end
  it with the chord in brackets — "Search (⌘K)" — and the chord reads as a key.
- A control that names a setting can be the value's mark and its name, with no chevron and no fill
  at rest — the prompter's permission control, as Codex draws its own. Each rung of a ladder takes
  its own mark from one family (a shield that asks, one that has said yes, one that warns), the
  menu's rows wear the same marks, and only the rung that removes a gate keeps a tone: on its ink,
  never as a resting fill, because a wash under a warning is a second warning about one setting.
- A toggle names its state or carries `aria-pressed`, never both — "Unfocus Two, pressed" is a
  sentence at war with itself. Which one it takes is a fact about the accessible NAME, so it may not
  become a difference in the fill: "this control is on" gets ONE appearance across a bar, or the
  reader learns two of them.
- A notice about something that already HAPPENED — a failed action, a refused file, a receipt — is a
  toast at the window's foot that leaves on its own, waits while it is read, and never covers the
  prompter's send button. A bar across the top that stays until closed is a chore charged for news.
  What needs a DECISION — a permission, a sign-in, a server that has gone — is not a toast: it stays
  where it is until it is answered.
- State the screen has stopped showing belongs on the control that changes it, not on a strip that
  reports it. A focused pane hides its siblings, and the answer to that was a banner across the top
  of the window reading "Focused: <title> | Unfocus" — a whole row of chrome, and a second place to
  look, to carry one bit. A lit toggle in the pane bar says it and undoes it in the same click. Ask
  what the banner is for before building it: if a control could wear the state instead, it should.
- Prefer a familiar symbol from Realm's icon set over a new illustration.
- A glyph holds the weight of the text beside it. The icon pack's stroke is in its 24-unit grid, so
  left alone it thins as the glyph shrinks — 0.75px at the 12 rung, a hairline that greyed out beside
  13px text and made every toolbar look faint. Small symbols are drawn relatively heavier, the way a
  Mac's are: `Icon` gives each rung an absolute stroke (`iconStroke`), floored at the small rungs and
  capped at 1.5px.
- A disabled control is still a control. Greying the label is the state; losing the shape is a
  different claim. A primary whose fill matches the sheet under it keeps the plain button's ring.
- Align asymmetric icons optically. A mathematically centered arrow or play mark can still look wrong.
- A press is a fill, not a size. AppKit buttons darken on the mouse-down frame and never shrink;
  the shrink is a touch idiom, where a finger hides the control and scale is the only feedback left
  to see. Pressed is one rung past hover on the ladder, or the accent darkened for a filled control.
- A press TRACKS the pointer: drag off a held button and it lets go at once, drag back and it lights
  again, which is how a person sees that releasing out there will not click. Chromium drops `:active`
  for good when a held pointer leaves, so the press is marked up (`press-tracking.ts`), not inferred.
- Hover and press ARRIVE instantly and only a hover's release fades. A highlight that eases in is the
  window making the pointer wait, which no Mac control does; the fade on the way out is what keeps a
  sweep across a row of buttons from strobing.
- A row chosen from a list — a menu item, a palette result, a segment — changes instantly in both
  directions. The highlight is the current choice, and a choice is never half-made.
- A sidebar row does not light under a passing pointer. Finder's, Mail's and Xcode's do not; the
  pointer reveals a row's own controls, and a click is what lights it.
- The arrow cursor over every control the app draws; the hand only over a link, where the click
  leaves what you are looking at. The hand on every button is the loudest single sign that a window
  is a web page.
- A window-drag region takes every press that is not opted out of it, and a LABEL is a control: the
  sidebar's old Spaces | Recent segments, labels round hidden radios, answered only on the radio's 13px.
- Chrome is not text. Buttons, rows, tabs, bars and menus do not select on a drag or a double-click,
  and their glyphs do not lift off as drag ghosts. Content and fields keep selection.
- A window that is not key greys its accent — selection, default button, checked boxes, lit
  switches — and keeps its LUMINANCE, so a label's contrast is unchanged under any theme. Build the
  grey where luminance is a channel (XYZ's Y), not from OKLCH's L, which is not luminance for a
  saturated hue. Link ink and code colour stay. The signal is the WINDOW's key state from main, not
  the page's focus: a click into a browser pane blurs the page while the window keeps the keyboard;
  and a window that opened behind another app asks for the state rather than waiting to be told.
- Menus are the system's. `Menu` hands its rows to an OS menu — material, type-to-select, and the
  only surface that can open over a browser pane's native view — and draws its own only where there
  is no bridge (tests, and live scripts that set `REALM_HTML_MENUS`). A two-step confirm reopens the
  menu with its rebuilt rows, because an OS menu cannot change under the pointer.
- The exception is a menu whose rows have to explain themselves — section heads, and a line after
  each name saying what the row does — which an OS menu row cannot carry: the prompter's "+". It is
  drawn in the app (`inApp`), and it owes everything the OS menu gave: the arrows across its
  sections as one list, Return, Escape, focus home to its control, the pointer moving the one
  highlight the keys move, and placement clear of a browser pane's native view (the popover hook
  slides it along its anchor's edge). A description belongs to the row's description, never its
  name, so a row is still found by what it is called.
- A right-click in text gets what a Cocoa text view gives it: spelling guesses, Look Up, the link or
  image under the pointer, then the edit commands — and nothing at all where there is nothing to
  offer. Electron gives a page none of this on its own.
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
- For someone who has never opened a terminal, first run's decision is which assistant, signed in
  with which account — and a card that only REPORTS "Not installed" or "Signed out" hands them a
  problem with no way to solve it. The agents Realm carries end to end are cards that do what their
  state needs in place: Install, Sign in with Claude, Sign in with ChatGPT, a field for the code the
  sign-in page shows, Ready. No command to copy, no terminal, no space required first; Claude needs
  no install at all, because Realm carries the binary its sessions run. Where Realm cannot do the
  step (no npm on the Mac), the card says why and points at what provides it. The page takes the whole
  window: nothing in the rail or the sidebar works before a space exists, and a first launch should
  not open on controls that do nothing. What the page leads with is asked for on its own: the two
  cards are probed ahead of the agents behind the fold, because a card that says "Checking…" until
  every agent has answered is waiting on the slowest one to say nothing about it.
- A row is a label and its control. A sentence under it has to say something neither of them says:
  what else the switch does, why the control you expected is absent, what a click will execute on
  your machine. A description that restates the row's own state chip — "macOS reports the grant"
  beside a chip reading Granted — or that paraphrases the command printed directly under it is how a
  page of settings becomes an essay, and nine of them under nine switches is most of the reading on
  the page. Everything else is the control's `title`: kept, reachable, and off the screen.
- A page's explanations are a line each. Where the full sentences matter — what Realm cannot do
  with a secret — fold them under ONE row that names every limit, rather than leaving paragraphs at
  the foot of the page: Sign-ins read as three paragraphs of fine print under four controls, and
  now reads as four short cards with the sentences one click under the row that lists them. A
  sentence's contract to appear on a surface ("any surface that takes a credential shows where it
  goes") is met on the surface that takes it — the sheet with the password field — not the list.
- A document a person writes keeps itself. A pause in typing writes it, leaving the field writes it
  at once, and the head says Edited, Saving…, Saved — the one fact a Save button carried, without a
  control whose resting state is disabled. A limit is named and refused, never enforced by trimming,
  and the text stays exactly as typed. Preview renders what the agent is handed.
- A control that carries a REQUEST must show what actually happened when the two can differ. A
  switch reading only its own state keeps claiming a thing the system is not doing — and the
  reasons it is not are worth telling apart, because one may resolve itself and another never
  will. Say nothing in the ordinary cases: a note that appears every time is a note nobody
  reads by the third session.
- A thing reached through several routes is listed ONCE, under the route a click takes, and its
  other routes ride on its own row as one click each. The model picker first hid a second route
  (Fable through Claude was reachable only by picking it under Cursor and re-routing in a detail
  pane), then listed Fable under both headings, which read as two models and still chose the route
  in a second place. Deduplicate the object AND its placements; never make a route a second step.
- Offer a capability only where its OWNER has said it exists. A table in the app goes stale,
  and a control offered on a guess is one whose only outcome is a refusal. Where the owner has
  said nothing, show nothing — not a disabled control, which invites a user to work out how to
  enable something nobody has claimed. The one exception is a REQUEST Realm can make and the owner
  will answer: fast mode before a session's first turn is a switch that says "checked on the first
  turn", because waiting for the answer made it unreachable for exactly the turn it was wanted on.
  Where the owner said no, say which of its models say yes.
- A link is shown as what it points AT. A pasted Slack permalink is ninety characters of nothing
  a person reads; its meaning is "this thread", and the chip says that: the app's mark, then a
  name (a thread's timestamp, an issue key, a page title). Only where Realm can name the link — a
  wrong name on a chip is worse than the URL, which at least says what it is. The agent is sent
  the link itself, as a markdown link, because its connection to that app is what opens it. The
  chip is the SAME chip as a mention, a picked element or the command opening a draft: a pill on
  the chip rung, a quiet tint of its kind's tone, its mark and its name — the accent for what
  reaches the agent, the success hue for a command that runs here, the warning tone for a skill that
  will go as plain text. Bare accent text with no shape of its own was what a click turned into the
  textarea's square selection; a chip with a shape is selected, hovered and removed as one thing —
  a selection that is exactly a chip is the chip's to draw, and under the pointer its mark becomes
  its ×. The icon says which kind of thing it is (a skill's spark, a picked element's target, an
  app's mark), drawn over the token's opening sigil, and the pill is a shadow outside the glyphs, so
  the painted run keeps every character's width. The sent message wears the same pill. Links in
  prose are colour and weight, no underline; hover restores it.
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
- A surface anchored to a control opens whole on ONE side of it: capped at the roomier side, with
  its one flexible part (a list) giving way, or it lands on the control that opened it or runs off
  the window — the model picker did both from a mid-window prompter. And anything in it that changes
  with the highlight holds a fixed height: a surface that grows upward moves every row above a
  taller line, and the row under the pointer with them.
- Two overlays that both answer Escape answer it in MOUNT order, not stacking order, because both
  listen on the window. The one underneath was registered first and wins, so `stopPropagation` from
  the top surface cannot save it: expanding a picture out of a sheet closed the sheet too. A full
  window overlay should REPLACE what it covers rather than sit on it — the thing underneath is
  invisible anyway, and unmounting it is what takes its key handler with it.
- Escape is a way out, so it must never also be an answer. In the transcript a request card takes
  Escape as Deny or Skip, and that is the card's whole surface; carried onto a page or popover whose
  Escape means "leave", the same key denied a request the person had only looked at. A surface that
  hosts a card catches Escape before the card does and leaves; a field being typed in keeps its own.
- A control that starts keeping what a person does says so in words and asks first. Record for Laya
  was a ring among a pane bar's icons that recorded on the click; it is now "Record my use of this
  app…", and its sheet says what is kept and what is left out — read from the code that keeps it,
  not from what it is for — where it goes, how big it gets and how it ends, and only Start records.
  While it runs, its Stop is on the thing being recorded and at the foot of the rail, because a
  recording goes on while its pane is out of sight.
- Destructive actions must name their target and distinguish removing from a layout from deleting the
  underlying object.

Use native menus, fields, and disclosure behavior where they fit. Do not make a custom control for a
styling opportunity.

The menu bar is a Mac app's: Settings… under the app's name on ⌘,, then File, Edit, View, Go, Window
(which macOS completes with the window list) and Help (which macOS gives a search field). Every app
row is a keybinding-catalog command showing the person's OWN shortcut, so a rebinding in Settings ▸
Keys rebinds the menu bar too. The keystroke goes to the page, never through the menu — a menu
accelerator fires first and would skip the `when` clauses that keep ⌘B bold in a rich field — and the
system's chords (copy, paste, undo, quit, hide) stay the menu's. Reload and Developer Tools are for
development builds only: ⌘R must never reload the app out from under someone's work.

The window comes back where it was left — size, place, maximised or full screen — unless the display
it was on is gone, in which case its size comes back centred on the main display.

## Motion

Motion preserves continuity and confirms state. It does not decorate idle work.

- Use transitions for hover, press, selection, resize, open, and close states so they can reverse.
- Use keyframes only for one-shot entrances or ambient states that genuinely need a loop.
- Interactive fills answer quickly; popovers and swaps are short; drawers and spatial moves may take
  longer. Use the duration and easing ladder in `tokens.css`.
- Stagger a composed entrance by semantic parts, not every child.
- Exits are shorter and quieter than entrances.
- A menu has no entrance. It opens whole, at once, and leaves on a short fade with no travel —
  NSMenu's behaviour. A popover is a panel, not a menu, and grows out of its anchor.
- Surfaces that arrive — popovers, sheets, the focus ring — travel on `--spring-smooth`, a critically
  damped spring that starts from rest. A cubic ease-out leaves at full speed, and that launch is the
  web transition's signature; a spring gathering and settling is what reads as an object.
- Scrollers give at their ends. Chromium rubber-bands only the page body and every Realm surface
  scrolls inside a pane, so the long reading surfaces stretch with rising resistance while fingers
  are on the trackpad, spring home on lift, and bounce once when a coast reaches an end
  (`rubber-band.ts`). The trackpad phase stream is what tells a trackpad from a mouse wheel, which
  never stretches; editors, terminals and grids keep their own engines' scrolling.
- Scrollbars follow the system. On a Mac that draws overlay bars, a page's colour repaints the
  system's thumb in the page's ink, and a `::-webkit-scrollbar` rule turns it into a classic bar with
  a gutter (8px against 0, measured). So Realm's thin line is for Macs whose system draws classic
  bars anyway, and stands down on the rest (`data-overlay-scrollbars`, measured, not read from a
  preference that depends on what is plugged in — this Mac changed mode mid-session as its Bluetooth
  mouse came and went).
- A column that opens or closes is a box that clips what it holds, its content riding one slide on
  the box's moving edge; everything beside it — the panes, a page over them, a bar's title — is laid
  out from that edge or moves on the same curve and duration. A layer placed against the window
  instead lands on its final edge in the first frame, and what it covers flashes through beside it.
- Contextual icon swaps use opacity, blur from 4 px to 0, and scale from 0.25 to 1 with no bounce.
- Do not animate content merely because it scrolled into view.
- Do not add parallax, auto-scrolling marquees, simulated typing, or decorative pulsing.
- Respect reduced-motion and reduced-transparency preferences. Realm's own Reduce motion setting is
  applied by changing what the window reports for `prefers-reduced-motion`, so a surface that honours
  the media query honours both, and nothing should ask about motion any other way.
- Playful motion is the one exception to the rule above it, and it is fenced. It ships only behind
  the easter-eggs switch, which defaults off, so the rules in this section still describe what Realm
  does out of the box. It never carries information a person would otherwise have to read from it, it
  respects reduced motion like everything else, and any hue it paints is derived from the live accent
  rather than chosen — the palette's other hues already mean something. Amplitude is calibrated to the
  hero greeting's nod, not to what the effect could do.
- A frame loop is outside every mechanism this app governs motion with, and has to re-implement all
  of them. Both of the controls above are CSS: reduced motion is an app-wide `* { animation: none }`,
  and the `data-quiet` pause the power audit measured is `animation-play-state`. A canvas driven by
  `requestAnimationFrame` answers to neither, so it keeps running under a preference that silenced
  everything else and burns a core in a window nobody is looking at — the two failures those
  mechanisms exist to prevent, reappearing in the one place they cannot reach. Read the media query
  and the `data-quiet` attribute in JS, and STOP the loop rather than throttling it: a canvas holds
  its last frame for free, which is the same "freezes where it stands, resumes where it was" the
  stylesheet gives everything else. The same applies to anything else that paints outside the
  cascade — a worklet, a WebGL context, a video drawn by hand.

## Spaces, panes, and navigation

- A space represents one body of work. Its sessions, files, connections, memory, and pane groups
  should feel related.
- A pane is a location, not decoration. Pane bars stay compact and consistent across pane kinds.
- Splits expose relationships. Avoid a split when one side has no ongoing value.
- A split is the user's arrangement; an agent never makes one. What a session's agents open — a
  browser, a device, a document, a sub-agent the user asked to look at — arrives as a tab of ONE
  side pane beside that session, never as a column of its own beside whatever had focus. A fan-out
  of six agents each opening a browser once filled a window with eight columns a fifth of it wide,
  every title an ellipsis and every page unreadable. In a side pane's bar the tabs are the data of
  unbounded length, so they keep the width and the shown item's own actions go to its menu. The
  agents still working are a count in the session's bar, and their list previews one on request;
  a tab dragged to an edge is how something becomes part of the user's own layout.
- What a pane SHOWS keeps its controls with it, not in the pane's bar, which in a side pane is the tab
  strip: the simulator's state and eight buttons there once left the tabs no width at all. A device
  wears a toolbar centred over it — its state and the presses used every minute, the rest one click
  away in an overflow that a narrow pane fills from the toolbar's end — and what is done WITH it
  (recording it for Laya) sits under it in the same pill, so the two read as one instrument.
- Work a clock starts is not work the person started. A scheduled run lands under its task on the
  Scheduled page, unread until its session is read, rather than opening a pane beside whatever the
  person is doing — and for it "never opened" is what unread means, where for a session somebody
  started it means nothing was missed.
- Pane focus, selection, zoom, navigation history, and group state must remain visibly distinct.
- Empty panes should offer the shortest honest path to useful work.
- Making a thing lands you IN it. Create on the New space sheet opens the space on a new session
  with the keyboard in the prompter; it used to open the space's Overview, a page of settings for
  something named a second earlier in order to work in it. Settings are where a thing is visited
  later, and the sheet that made it has already asked everything that had no default.
- Several agents need one page that answers "what should I look at": every session across every
  space by what it needs from you — blocked on a permission first, then working, failed, finished.
  The per-space badges say the same thing per space; the page says it once, with enough on each
  row (space, folder, model, how long ago it moved) to choose without opening. A relay beyond the
  Mac (a text, a Slack line) carries only those moments a person has to come back for, and one
  open condition is sent once.
- The sidebar answers where the user is and what else is available. Keep primary destinations,
  spaces, open items, and contextual actions visually separate.
- One column of navigation at a time. A page with sections of its own — Settings, the Library, a
  profile's or a space's page — draws them IN the sidebar's column while it is up, under a Back that
  closes the page, rather than as a rail beside the sidebar: two side-by-side lists of places, the
  left one about somewhere else, read as two sidebars. The sections wear the column's own row
  anatomy, so it is the same sidebar listing something else, and the page they leave behind is a
  centred column. Where there is no column to take — the sidebar collapsed — the rail stays in the
  page, where it can still be reached (`components/page-nav.tsx`).
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
- Handing work to other models is a REQUEST to the session's own agent, in the user's words — not a
  side door that starts sub-agents behind it. The Agents tab's composer only makes the request
  well-formed: each model by the name the server resolves, the tools that do it named too. The agent
  stays the one who splits the work, reads the reports and answers for them, and the transcript holds
  the ask beside everything done about it.
- A sub-agent in its lead's transcript is a line of its own — "Subagent finished · <task>", its model,
  its time — and is never folded into the ledger. A fan-out is two starts and a wait in a row, which
  is a run, and a settled run collapses to "Worked for 8s": the one thing a reader of a delegation
  came for, hidden behind the one line that says nothing about it.
- A question is one card whichever agent or server asked it, and it says who is asking first —
  "Codex asks", "Linear's MCP server asks" — because the same question means something different from
  each. What a field offers comes from Realm's own sources (the model catalog, the checkout, the
  workspace), never from the asker, and every label is drawn as text. Answered, it stays where it was
  asked as the question and its answer, a masked answer only ever its mark.
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
- An `@` names a thing, and naming it is consent to USE it — never a way round how it is used. A
  mentioned app gets computer use for that session and that app alone: its first action still asks,
  the session's mode still holds, and nothing outlives the session or becomes a space setting. A
  mentioned file is handed over as an attached one is, and the chip IS the file, so no tile repeats
  it. A bare `@` is a short tour of what can be named, under quiet heads; a typed word is one list
  ranked across every kind, where each row says what it is because the heads are gone.
- A control on what an agent did does exactly that, or is not drawn. A turn's edit counts come
  from git at its settle, not from what its tool calls claimed; Undo appears only when restoring
  takes back that turn and nothing after it, and says why when it cannot. A file named in prose
  becomes a link only once the disk says it is in this checkout, and opens beside the session.
- Never invent human-like agent presence, mood, or certainty.

## Documents, diffs, terminals, and data

- Editors and terminals use the available pane. Avoid centered card-width work areas.
- A terminal's sixteen colours carry two jobs that pull apart: text a program prints on the pane's
  ground, and the ground a powerline prompt prints its segments on. Author them for the text — every
  text colour, bright black included, at AA on the ground, faint text at the app's secondary ink —
  leave the 240 a program names itself to the program, and let xterm's contrast floor rescue the few
  pairs that miss: low on the dark face, where those colours were chosen for a dark ground, AA on
  the light one, where they were not. A tab names what its terminal runs; only an agent wears its
  vendor's colour there, on its tile, so colour in a strip of tabs means an agent and nothing else.
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
- A file is one square tile, as Codex's library lays them out. A file whose picture IS the file is
  that picture, edge to edge, its name and session coming up over a scrim under the pointer or the
  focus; any other file is its name at the head, its glyph at the middle and where it came from at
  the foot. One square for both, so the grid's shape never changes from file to file. A name wraps
  between its words and keeps its extension whole — breaking anywhere is how Codex's own tile ends
  in "…pd" over "f". A tile that wide needs a picture minted for it — the 96px mark the composer's
  chips use is a smear there — so the size is named, not assumed.
- A browser of files leads with what KIND of thing a file is, as tabs, because that is the first
  narrowing a person reaches for. The rarer ones — which space, who made it — live behind a filter
  that lights while it narrows and says so as a chip by the tabs, undone from there: a list that is
  shorter than it should be has to say why. The toolbar is the column's head, outside its scroller.
- A documents pane with nothing open is a home, not a void: what this session made and was given,
  then the Library's, under one search that also reaches the checkout's own names, and a New that
  says what every kind it writes is — a code file among them, since nothing else on screen says a
  `.py` is a document the pane can write. Finding a file is that search; a palette that found one
  and opened it somewhere else was a second door to the same room.
- A file the app shows behaves like one in the Finder: Space opens it in Quick Look (Return still
  acts), it drags out to the Finder or into another app, and its menu offers Quick Look and the
  system Share menu. Each is offered only where the desktop bridge has it — a Space that swallows the
  key, or a drag into nothing, is a promise the app would be breaking — and every path is re-gated in
  main, because it comes from the renderer.
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
- Never lowercase a rendered label to splice it into a sentence. `Next ${whenLabel(t).toLowerCase()}`
  reads correctly for as long as every value lands on "Today" or "Tomorrow", and prints "Next sep 30"
  the first time one reaches the branch holding a month or a weekday — which may be the day a new
  feature arms the first row that gets there. Lower the relative words and the meridiem; leave the
  proper nouns alone.

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

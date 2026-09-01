import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/** §6's motion table and its "do NOT animate" list are enforceable only against the stylesheet
 *  itself — jsdom has no layout, no compositor and no CSSOM for a raw file, so nothing else in the
 *  suite can notice a stray `transition:` on a resize handle or a pop-in creeping back onto the
 *  command palette. These read the real `styles.css` and assert the values written by hand from the
 *  spec, so a one-line edit to a duration, an easing or a forbidden surface fails here. */
/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd instead
   (vitest may be invoked from the repo root or from apps/desktop). */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
/* Comments are stripped first: they sit between rules and would otherwise be swallowed into the
   following selector, and prose about `transition: all` must not read as a use of it. */
const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Flat (non-nested) rules: `selector { body }`. Bodies containing braces — @media, @keyframes —
 *  never match as a whole, so their inner rules are picked up with their own bare selectors instead. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean),
  body: m[2]!.replace(/\s+/g, " ").trim(),
}));

/** Every declaration block of every rule that lists `selector` as one of its comma-separated parts. */
const bodiesFor = (selector: string): string[] => {
  const hits = RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.body);
  expect(hits.length, `no rule in styles.css targets \`${selector}\``).toBeGreaterThan(0);
  return hits;
};

/** Brace-balanced contents of every block introduced by `prelude` (an at-rule or keyframes header). */
function blocksAfter(prelude: string): string[] {
  const out: string[] = [];
  for (let at = css.indexOf(prelude); at >= 0; at = css.indexOf(prelude, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push(css.slice(open + 1, i)); break; }
    }
  }
  expect(out.length, `${prelude} is missing from styles.css`).toBeGreaterThan(0);
  return out;
}
const blockAfter = (prelude: string): string => blocksAfter(prelude).join("\n");

describe("§6 motion table", () => {
  it("sheets enter at 240ms ease-out-strong with a .96 scale — one rule for every sheet, no per-sheet carve-out", () => {
    expect(bodiesFor(".sheet").join(" ")).toContain("animation: rl-sheet-in 240ms var(--ease-out-strong)");
    expect(blockAfter("@keyframes rl-sheet-in")).toContain("scale(.96)");
    // W4b scoped 240ms to onboarding alone; W5's whole job was to hoist it. If the override comes
    // back, the shared sheet has silently regressed to something else.
    expect(bodiesFor(".sheet.onboarding").join(" ")).not.toContain("animation");
  });

  it("the sheet scrim fades on its own at 160ms", () => {
    expect(bodiesFor(".sheet-backdrop").join(" ")).toContain("animation: rl-fade-in 160ms");
  });

  it("menus enter at 140ms ease-out-strong, scale .97→1, from an origin the component supplies", () => {
    expect(bodiesFor(".menu").join(" ")).toContain("animation: rl-menu-in 140ms var(--ease-out-strong)");
    expect(blockAfter("@keyframes rl-menu-in")).toContain("scale(.97)");
  });

  it("the model picker is a popover and enters on the same rule as menus, not one of its own", () => {
    // It shares `.menu`'s declaration rather than carrying a copy: §6 gives every popover one timing,
    // and a second animation here is how the prompter's picker drifts away from every other surface.
    expect(bodiesFor(".model-picker").join(" ")).toContain("animation: rl-menu-in 140ms var(--ease-out-strong)");
    // Its interactive rows honour the hover rule — background/colour only, never geometry.
    for (const sel of [".mp-row", ".mp-rail-btn"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("transition: background-color 100ms ease, color 100ms ease");
      expect(bodiesFor(sel).join(" "), sel).not.toContain("transform");
    }
  });

  it("transcript items enter at 180ms with a 6px rise, gated on the data-enter mark Transcript.tsx sets", () => {
    expect(bodiesFor(".transcript-col > [data-enter]").join(" ")).toContain("animation: rl-msg-in 180ms var(--ease-out-strong)");
    expect(blockAfter("@keyframes rl-msg-in")).toContain("translateY(6px)");
  });

  it("hover fills run 100ms on plain `ease` and touch background/colour only — never geometry", () => {
    const hover = bodiesFor(".item-row").join(" ");
    expect(hover).toContain("transition: background-color 100ms ease, color 100ms ease");
    expect(hover).not.toContain("transform");
  });

  it("pressables scale to .97 over 120ms", () => {
    const press = bodiesFor(".ghost-chip").join(" ");
    expect(press).toContain("transform 120ms var(--ease-out-strong)");
    for (const sel of [".btn:active:not(:disabled)", ".icon-btn:active:not(:disabled)", ".composer-send:active:not(:disabled)"])
      expect(bodiesFor(sel).join(" "), sel).toContain("transform: scale(.97)");
  });

  it("the send↔stop icon swap cross-fades over 160ms with opacity, scale and blur", () => {
    const swap = bodiesFor(".composer-send svg").join(" ");
    for (const prop of ["opacity 160ms", "transform 160ms", "filter 160ms"]) expect(swap, prop).toContain(prop);
    expect(bodiesFor('.composer-send[data-state="send"] .stop-icon').join(" ")).toContain("blur(4px)");
  });

  it("the tool row expands by animating grid-template-rows over 200ms, with the content fading at 120ms", () => {
    expect(bodiesFor(".tool-body-wrap").join(" ")).toContain("transition: grid-template-rows 200ms var(--ease-in-out-strong)");
    expect(bodiesFor(".tool-body-wrap").join(" ")).toContain("grid-template-rows: 0fr");
    expect(bodiesFor(".tool-card[data-open] .tool-body-wrap").join(" ")).toContain("grid-template-rows: 1fr");
    expect(bodiesFor(".tool-body").join(" ")).toContain("transition: opacity 120ms ease");
  });

  it("the copy ✓ swap uses the same 160ms opacity/scale/blur cross-fade as send↔stop", () => {
    const swap = bodiesFor(".tool-copy .copy-icon").join(" ");
    for (const prop of ["opacity 160ms", "transform 160ms", "filter 160ms"]) expect(swap, prop).toContain(prop);
    expect(bodiesFor(".tool-copy:not([data-copied]) .copied-icon").join(" ")).toContain("blur(4px)");
  });

  it("W2's prompter hero→docked move keeps its 320ms ease-in-out-strong (§6 assigns that easing to on-screen movement)", () => {
    expect(bodiesFor(".composer-dock").join(" ")).toContain("transition: transform 320ms var(--ease-in-out-strong)");
  });

  it("W2's suggestion-chip stagger keeps §6's 220ms / 40ms steps / 8px rise", () => {
    const stagger = bodiesFor(".suggestions[data-animate] .suggestion-chip").join(" ");
    expect(stagger).toContain("rl-chip-in 220ms var(--ease-out-strong)");
    expect(stagger).toContain("calc(var(--i) * 40ms)");
    expect(blockAfter("@keyframes rl-chip-in")).toContain("translateY(8px)");
  });

  it("the waiting status dot keeps the 0.9s pulse — §6's only looping motion at rest", () => {
    expect(bodiesFor('.status-dot[data-status="waiting_permission"]').join(" ")).toContain("rl-pulse 0.9s ease-in-out infinite");
  });

  it("`will-change` is reserved for the swiper track (§6 performance note)", () => {
    const owners = RULES.filter((r) => r.body.includes("will-change")).flatMap((r) => r.selectors);
    expect(owners).toEqual([".swiper-track"]);
  });
});

describe("Ara refresh §3/§4 geometry", () => {
  it("the user message is Ara's signature: raised card, window radius (BUI 14), 14px 16px padding, 85% wide, ragged-left", () => {
    // Plan 9 W1 re-pin: the literal 14px became var(--r-float), which the bridge pins to BUI's
    // --radius-window (14px) — same geometry, now on the token scale.
    const body = bodiesFor(".msg-user").join(" ");
    for (const decl of ["text-align: right", "max-width: 85%", "border-radius: var(--r-float)", "padding: 14px 16px", "background: var(--rl-raised)"])
      expect(body, decl).toContain(decl);
  });

  it("transcript prose reads at 15px/1.6 — user card and assistant prose alike", () => {
    for (const sel of [".msg-user", ".msg-assistant"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("font-size: 15px");
      expect(body, sel).toContain("line-height: 1.6");
    }
  });

  it("suggestions are a single-column list, not a grid", () => {
    const body = bodiesFor(".suggestions").join(" ");
    expect(body).toContain("flex-direction: column");
    expect(body).not.toContain("grid");
    expect(bodiesFor(".suggestion-chip").join(" ")).toContain("background: transparent"); // transparent at rest, --rl-hover on hover
    expect(bodiesFor(".suggestion-chip:hover").join(" ")).toContain("var(--rl-hover)");
  });

  it("the send button is a 32px circle; the hero textarea starts at ~56px", () => {
    const send = bodiesFor(".composer-send").join(" ");
    expect(send).toContain("width: 32px");
    expect(send).toContain("height: 32px");
    expect(bodiesFor('.session-pane[data-composer="hero"] .composer-input').join(" ")).toContain("min-height: 56px");
  });

  /* The rich-text mirror is only correct while it is metrically IDENTICAL to the textarea it sits
     under: same font, same size, same line-height, same padding box, same wrapping. Nothing in jsdom
     can notice a drift here — there is no layout — so the stylesheet is the only place to catch a
     stray padding tweak that would slide every painted glyph off the caret above it. */
  it("the highlight mirror matches the textarea's text metrics exactly", () => {
    const mirror = bodiesFor(".composer-highlight").join(" ");
    const input = bodiesFor(".composer-input").join(" ");
    for (const decl of ["font: inherit", "font-size: 15px", "line-height: 1.55", "padding: 14px 16px 6px"]) {
      expect(mirror, decl).toContain(decl);
      expect(input, decl).toContain(decl);
    }
    // The UA's own textarea wrapping, restated — the mirror is a <div> and gets neither by default.
    expect(mirror).toContain("white-space: pre-wrap");
    expect(mirror).toContain("overflow-wrap: break-word");
    // Out of the flow, and never in the way of the pointer: the textarea owns both.
    expect(mirror).toContain("position: absolute");
    expect(mirror).toContain("pointer-events: none");
    // The glyphs belong to the mirror. `color` alone is not enough to hide the textarea's own.
    expect(input).toContain("-webkit-text-fill-color: transparent");
    // Selected text too, or the UA's selection foreground paints the hidden glyphs back over the mirror.
    expect(bodiesFor(".composer-input::selection").join(" ")).toContain("-webkit-text-fill-color: transparent");
    // ...but the placeholder shows in exactly the state the mirror is empty, so it opts back in.
    expect(bodiesFor(".composer-input::placeholder").join(" ")).toContain("-webkit-text-fill-color: var(--rl-text-faint)");
    // A classic scrollbar would take width from the textarea's text box and not from the mirror's.
    expect(input).toContain("scrollbar-width: none");
  });

  it("the control row's left group clips instead of wrapping — the measured collapse depends on it", () => {
    const body = bodiesFor(".composer-opts").join(" ");
    expect(body).toContain("flex-wrap: nowrap");
    expect(body).toContain("overflow: hidden");
    expect(bodiesFor(".composer-opts > *").join(" ")).toContain("flex: none");
  });
});

describe("Plan 9 W1 — the BUI bridge", () => {
  const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");

  it("the foundation imports Tailwind v4 and shadow-plugin, and keys dark on Realm's data-mode", () => {
    expect(tokens).toContain('@import "tailwindcss"');
    expect(tokens).toContain('@import "shadow-plugin/unprefixed"');
    // BUI ships `@custom-variant dark (.dark)`; Realm's theme mechanism stamps data-mode instead.
    expect(tokens).toMatch(/@custom-variant dark[^;]*data-mode="dark"/);
    // Dark is the primary palette: the base :root block carries the dark surface ramp…
    expect(tokens).toMatch(/:root \{[^}]*--surface: oklch\(0\.26 0\.006 271\.191\)/);
    // …and BUI's light-first values live under the light mode attribute.
    expect(tokens).toMatch(/:root\[data-mode="light"\] \{[^}]*--surface: oklch\(1 0 0\)/);
  });

  it("every legacy --rl-* colour token resolves to a BUI token — the app can never be half-themed", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    for (const [token, source] of [
      ["--rl-accent", "var(--accent)"],
      ["--rl-frame", "var(--page)"],
      ["--rl-panel", "var(--canvas)"],
      ["--rl-raised", "var(--surface)"],
      ["--rl-line", "var(--line)"],
      ["--rl-line-strong", "var(--line-strong)"],
      ["--rl-hairline", "var(--line)"],
      ["--rl-text-bright", "var(--ink)"],
      ["--rl-text-dim", "var(--ink-2)"],
      ["--rl-text-faint", "var(--ink-3)"],
      ["--rl-danger", "var(--red)"],
      ["--rl-success", "var(--green)"],
      ["--rl-warning", "var(--orange)"],
      ["--rl-edge", "var(--shadow-hairline)"],
    ] as const) expect(root, token).toContain(`${token}: ${source}`);
  });

  it("the radius scale is BUI's: chip 6, control 8, card 10 (rows + panels), window 14", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    for (const decl of ["--r-chip: 6px", "--r-ctl: 8px", "--r-row: 10px", "--r-panel: 10px", "--r-float: 14px"])
      expect(root, decl).toContain(decl);
    // No component may dodge the scale with a hardcoded control-ish radius (ticks/dots/pills excepted).
    expect(css).not.toMatch(/border-radius:\s*(?:4|6|8|10|12|14|16)px/);
  });

  it("the sidebar keeps its vibrancy: BUI --page at 82%, one mode-agnostic rule", () => {
    expect(bodiesFor(".sidebar").join(" ")).toContain("color-mix(in srgb, var(--page) 82%, transparent)");
    // The old per-mode rgba override is gone — --page flips with data-mode on its own.
    expect(css).not.toContain("rgba(244,244,244,.82)");
  });

  it("Inter and JetBrains Mono are self-hosted with Inter leading the UI stack", () => {
    expect(css).toContain('src: url("./assets/fonts/InterVariable.woff2") format("woff2")');
    expect(css).toMatch(/--font-ui:\s*"Inter"/);
    expect(css).toMatch(/--font-mono:\s*"JetBrains Mono"/);
  });

  it("markdown lists survive Tailwind preflight's list-style reset", () => {
    expect(bodiesFor(".md ul").join(" ")).toContain("list-style: disc");
    expect(bodiesFor(".md ol").join(" ")).toContain("list-style: decimal");
  });
});

describe("Plan 9 W2 — BUI transcript primitives", () => {
  it("the permission card wears ApprovalCard's shell: a resting surface card on shadow-card with a hairline-topped footer", () => {
    // Re-pin from §5's floating raised+overlay-shadow treatment: BUI cards rest in the flow.
    const card = bodiesFor(".permission-card").join(" ");
    expect(card).toContain("background: var(--surface)");
    expect(card).toContain("box-shadow: var(--shadow-card)");
    expect(card).toContain("border-radius: var(--r-panel)");
    expect(bodiesFor(".permission-footer").join(" ")).toContain("border-top: 1px solid var(--line)");
    // The kbd number chips take BUI's inset fill + hairline ring.
    const num = bodiesFor(".permission-num").join(" ");
    expect(num).toContain("background: var(--inset)");
    expect(num).toContain("box-shadow: var(--shadow-hairline)");
  });

  it("the tool ledger wears ThinkingState: shimmer on the working header (data-working, never a clock), a solid 1px trace rail, muted settled checks", () => {
    const shimmer = bodiesFor('.tool-group[data-working] .tool-group-summary').join(" ");
    expect(shimmer).toContain("animation: shimmer-text 1.4s linear infinite");
    expect(shimmer).toContain("background-clip: text");
    // BUI's trace rail is a solid hairline; the old dashed connector is gone.
    expect(bodiesFor(".tool-group-steps").join(" ")).toContain("border-left: 1px solid var(--line)");
    // The settled check is muted ink, not green — colour stays for errors.
    expect(bodiesFor('.tool-card[data-state="ok"] .tool-status').join(" ")).toContain("color: var(--ink-3)");
    // The row's target is ToolChips' field-fill chip.
    const chip = bodiesFor(".tool-summary").join(" ");
    expect(chip).toContain("background: var(--field)");
    expect(chip).toContain("box-shadow: var(--shadow-hairline)");
    // Measured edit counts are the semantic green/red.
    expect(bodiesFor(".tool-stat-add").join(" ")).toContain("var(--green)");
    expect(bodiesFor(".tool-stat-del").join(" ")).toContain("var(--red)");
  });

  it("fenced code is CodeBlock's editor panel: surface + hairline ring, a language header, 12.5/1.65 mono body", () => {
    const panel = bodiesFor(".md-code").join(" ");
    expect(panel).toContain("background: var(--surface)");
    expect(panel).toContain("box-shadow: var(--shadow-hairline)");
    expect(bodiesFor(".md-code-head").join(" ")).toContain("border-bottom: 1px solid var(--line)");
    const body = bodiesFor(".md-code pre").join(" ");
    expect(body).toContain("font-size: 12.5px");
    expect(body).toContain("line-height: 1.65");
  });

  it("the streaming caret is StreamText's solid 2px ink bar — no pulse, no blink while streaming", () => {
    const caret = bodiesFor(".md-caret").join(" ");
    expect(caret).toContain("width: 2px");
    expect(caret).toContain("background: var(--ink)");
    expect(caret).not.toContain("animation");
  });

  it("diff lines carry the CodeBlock diff treatment: token tints, a 3px bar (solid green add, red hatch delete), coloured gutters", () => {
    expect(bodiesFor('.diff-line[data-kind="add"]').join(" ")).toContain("background: var(--green-tint)");
    expect(bodiesFor('.diff-line[data-kind="add"]::before').join(" ")).toContain("background: var(--green)");
    expect(bodiesFor('.diff-line[data-kind="del"]').join(" ")).toContain("background: var(--red-tint)");
    expect(bodiesFor('.diff-line[data-kind="del"]::before').join(" ")).toContain("repeating-linear-gradient(45deg, var(--red)");
    expect(bodiesFor('.diff-line[data-kind="add"]::before, .diff-line[data-kind="del"]::before'.split(", ")[0]!).join(" ")).toContain("width: 3px");
  });
});

describe("Plan 9 W3 — composer + chrome in BUI language", () => {
  it("the composer wears PromptBar's field card: surface on shadow-card, focus = the line-strong border-brighten (the 30% accent glow is gone)", () => {
    const card = bodiesFor(".composer").join(" ");
    expect(card).toContain("background: var(--surface)");
    expect(card).toContain("box-shadow: var(--shadow-card)");
    const focus = bodiesFor(".composer:focus-within").join(" ");
    expect(focus).toContain("0 0 0 1px var(--line-strong)");
    expect(focus).not.toContain("--rl-accent");
  });

  it("attachment chips are the field-fill chip: field ground behind a hairline ring, 11.5 ink-2", () => {
    const chip = bodiesFor(".attach-chip").join(" ");
    expect(chip).toContain("background: var(--field)");
    expect(chip).toContain("box-shadow: var(--shadow-hairline)");
    expect(chip).toContain("font-size: 11.5px");
  });

  it("the send circle carries BUI Button's accent treatment: inset top highlight, accent-ink hover, PromptBar's line-strong disabled fill", () => {
    expect(bodiesFor(".composer-send").join(" ")).toContain("inset 0 1px 0 rgba(255,255,255,0.14)");
    expect(bodiesFor(".composer-send:hover:not(:disabled)").join(" ")).toContain("background: var(--accent-ink)");
    const off = bodiesFor(".composer-send:disabled").join(" ");
    expect(off).toContain("background: var(--line-strong)");
    expect(off).toContain("color: var(--ink-2)");
  });

  it("the Thinking strip shimmers on the shared shimmer-text gradient — no opacity pulse", () => {
    expect(bodiesFor(".composer-thinking span").join(" ")).not.toContain("rl-pulse");
    // one shimmer rule serves all three surfaces; membership is the pin
    const shimmer = RULES.find((r) => r.selectors.includes(".shimmer-text"));
    expect(shimmer?.selectors).toContain(".composer-thinking span");
  });

  it("warning pills speak the orange tone pair (StatusPill), not the old color-mix formula", () => {
    const pill = bodiesFor(".bypass-confirm").join(" ");
    expect(pill).toContain("color: var(--orange)");
    expect(pill).toContain("background: var(--orange-tint)");
    expect(bodiesFor('.ghost-chip[data-warning]').join(" ")).toContain("var(--orange-tint)");
  });

  it("menus and the model picker are surface cards on shadow-raised with the opaque hover ladder (GlideMenu's surface, minus its JS glide layer)", () => {
    for (const sel of [".menu", ".model-picker"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("background: var(--surface)");
      expect(body, sel).toContain("box-shadow: var(--shadow-raised)");
      expect(body, sel).not.toContain("--rl-shadow");
    }
    expect(bodiesFor('.menu [role="menuitem"]:focus, .menu [role="menuitemcheckbox"]:focus'.split(", ")[0]!).join(" ")).toContain("var(--hover)");
  });

  it("sheets and the palette are surface cards at window radius on shadow-overlay — and the palette stays instant (pinned above)", () => {
    for (const sel of [".sheet", ".palette"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("background: var(--surface)");
      expect(body, sel).toContain("box-shadow: var(--shadow-overlay)");
    }
  });

  it("sidebar actives are a fill alone — SidebarNav has no accent tick and no weight bump", () => {
    expect(RULES.some((r) => r.selectors.includes(".item[data-active]::before"))).toBe(false);
    const active = bodiesFor(".item[data-active] .item-row").join(" ");
    expect(active).toContain("color: var(--rl-text-bright)");
    expect(active).not.toContain("font-weight");
    // the fills stay TRANSLUCENT (--rl-active), the W1 vibrancy carve-out for the material column
    expect(bodiesFor(".item[data-active]").join(" ")).toContain("background: var(--rl-active)");
  });

  it("the sidebar search is SidebarNav's field: field fill behind a hairline ring at 13/500; rows and labels take BUI's 8px/12.5px", () => {
    const search = bodiesFor(".search").join(" ");
    expect(search).toContain("background: var(--field)");
    expect(search).toContain("box-shadow: var(--shadow-hairline)");
    expect(search).toContain("font-size: 13px");
    expect(bodiesFor(".item").join(" ")).toContain("border-radius: var(--r-ctl)");
    expect(bodiesFor(".group-label").join(" ")).toContain("font-size: 12.5px");
  });

  it("buttons are BUI Button's tiers: secondary = surface on shadow-btn stepping to inset; primary = accent with the filled highlight and accent-ink hover", () => {
    const btn = bodiesFor(".btn").join(" ");
    expect(btn).toContain("background: var(--surface)");
    expect(btn).toContain("box-shadow: var(--shadow-btn)");
    expect(bodiesFor(".btn:hover:not(:disabled)").join(" ")).toContain("background: var(--inset)");
    const primary = bodiesFor(".btn.primary").join(" ");
    expect(primary).toContain("inset 0 1px 0 rgba(255,255,255,0.14)");
    expect(bodiesFor(".btn.primary:hover:not(:disabled)").join(" ")).toContain("background: var(--accent-ink)");
  });
});

describe("§6 do-NOT-animate list", () => {
  it("never uses `transition: all` anywhere", () => {
    expect(css).not.toMatch(/transition:\s*all\b/);
    expect(css).not.toMatch(/transition-property:\s*all\b/);
  });

  it("the command palette and its scrim are instant — ⌘K is a 100×/day action (Raycast rule)", () => {
    for (const sel of [".palette", ".palette-backdrop"]) {
      for (const body of bodiesFor(sel)) {
        expect(body.match(/animation:\s*([^;]*)/)?.[1]?.trim() ?? "none", `${sel} { ${body} }`).toBe("none");
        expect(body, `${sel} { ${body} }`).not.toContain("transition");
      }
    }
  });

  it("the prompter's drop target is instant — §6 does not animate anything during an active drag", () => {
    for (const sel of [".composer[data-dropping]", ".composer-drop-hint"]) {
      for (const body of bodiesFor(sel)) {
        expect(body, `${sel} { ${body} }`).not.toContain("transition");
        expect(body, `${sel} { ${body} }`).not.toContain("animation");
      }
    }
    // …and the hint never eats the drop it is describing.
    expect(bodiesFor(".composer-drop-hint").join(" ")).toContain("pointer-events: none");
  });

  it("resize handles carry no transition or animation — a drag must track the pointer exactly", () => {
    for (const r of RULES.filter((x) => x.selectors.some((s) => s.startsWith(".resize-handle")))) {
      expect(r.body, r.selectors.join(",")).not.toContain("transition");
      expect(r.body, r.selectors.join(",")).not.toContain("animation");
    }
  });

  it("the focused-pane marks are instant — §6 does not animate pane focus switching", () => {
    // The underline, the inked header icon and the empty-leaf top rule all move when focus moves.
    const focusRules = RULES.filter((x) => x.selectors.some((s) => /^\.panel(\[data-focused\]|-title|-icon)/.test(s)));
    expect(focusRules.length).toBeGreaterThanOrEqual(3);
    for (const r of focusRules) expect(r.body, r.selectors.join(",")).not.toContain("transition");
  });

  it("a theme swap is fenced by a root mark that kills every transition (useTheme sets it)", () => {
    expect(bodiesFor(":root[data-theme-switching] *").join(" ")).toContain("transition: none !important");
  });

  it("prefers-reduced-motion strips every animation and transition, and hides the spinner", () => {
    const reduced = blockAfter("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain(".spin { display: none; }");
  });
});

/** The three layout regressions the space page and the icon picker shipped with. All of them are
 *  invisible to the rest of the suite for the same reason §6's motion table is — jsdom has no
 *  layout — so the guard has to be against the declarations themselves. */
describe("row and control layout", () => {
  it("a button lays its glyph and label out as a centered row that cannot wrap or shrink", () => {
    // `.btn` was `display: block`: an icon-plus-label button ("+ New session", "Generate") put its
    // glyph on the baseline with only a JSX whitespace node for spacing, and shrank under its own
    // label until the text wrapped out of the fixed 30px box.
    const btn = bodiesFor(".btn").join(" ");
    expect(btn).toContain("display: inline-flex");
    expect(btn).toContain("align-items: center");
    expect(btn).toContain("gap:");
    expect(btn).toContain("white-space: nowrap");
    expect(btn).toContain("flex-shrink: 0");
  });

  it("a page row has exactly one elastic column, so its trailing metadata forms a straight edge", () => {
    // The bug: `.page-row-dim` and `.item-status` both carried `margin-left: auto`, which splits the
    // leftover space between them — every row parked its timestamp at a different x. The title grows
    // instead, and nothing after it may claim free space.
    const title = bodiesFor(".page-row-title").join(" ");
    expect(title).toMatch(/flex: 1|flex-grow: 1/);
    expect(title).toContain("min-width: 0");
    for (const sel of [".page-row-dim", ".page-row-dim + .page-row-dim"]) {
      for (const body of bodiesFor(sel)) expect(body, `${sel} { ${body} }`).not.toContain("margin-left: auto");
    }
    // …and the leading glyph is not a shrinkable column either: it went sub-pixel on narrow panes.
    expect(bodiesFor(".page-row > svg").join(" ")).toContain("flex: none");
  });

  it("a busy control keeps its fill — only a nothing-to-do control is greyed out", () => {
    // `.btn.primary:disabled` is written for "there is nothing to commit"; applied to "Generating…"
    // it erased the button under the press that started the work.
    const busy = bodiesFor('.btn.primary:disabled[aria-busy="true"]').join(" ");
    expect(busy).toContain("background: var(--rl-accent)");
    expect(bodiesFor('.btn:disabled[aria-busy="true"]').join(" ")).toContain("opacity: .7");
    // The distinction only exists if the plain disabled treatment is still the dimmer one.
    expect(bodiesFor(".btn.primary:disabled").join(" ")).toContain("background: var(--rl-raised)");
    expect(bodiesFor(".btn:disabled").join(" ")).toContain("opacity: .45");
  });
});

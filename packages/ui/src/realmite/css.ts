/** The Realmite's stylesheet: which face's colours to wear, and the four loops.
 *
 *  Colours ride on the SVG as custom properties for BOTH faces (`--rmt-body-d`, `--rmt-body-l`), and
 *  this picks one by the nearest `[data-mode]` — the attribute Realm's theme writes on the root — so a
 *  Realmite changes face with the window and never has to be told the mode. Dark is the default
 *  because Realm is dark-first.
 *
 *  Motion is CSS and nothing else, which is what lets the app's own controls reach it: Reduce motion
 *  (the app's setting is applied by changing what the window reports for the media query) stops every
 *  loop, and `data-quiet` pauses them where they stand. Each state's still pose is drawn in the
 *  geometry, not by the animation, so a held-still Realmite still says what it is doing. */

const KEYS = ["body", "shade", "light", "ink", "white", "blush", "wear", "wearLight", "leaf"];
const pick = (face: "d" | "l") => KEYS.map((k) => `--rmt-${k}:var(--rmt-${k}-${face});`).join("");

export const REALMITE_CSS = `
.rmt{display:block;flex:none;overflow:visible;${pick("d")}}
[data-mode="light"] .rmt:not([data-face="dark"]),.rmt[data-face="light"]{${pick("l")}}
.rmt-c-body{fill:var(--rmt-body)}
.rmt-c-shade{fill:var(--rmt-shade)}
.rmt-c-light{fill:var(--rmt-light)}
.rmt-c-ink{fill:var(--rmt-ink)}
.rmt-c-white{fill:var(--rmt-white)}
.rmt-c-blush{fill:var(--rmt-blush)}
.rmt-c-tongue{fill:var(--rmt-blush)}
.rmt-c-wear{fill:var(--rmt-wear)}
.rmt-c-wearLight{fill:var(--rmt-wearLight)}
.rmt-c-leaf{fill:var(--rmt-leaf)}
.rmt-c-wait{fill:var(--orange,#d9822b)}
.rmt-s-ink,.rmt-s-wear,.rmt-s-leaf,.rmt-s-quiet{fill:none;stroke-linecap:round;stroke-linejoin:round}
.rmt-s-ink{stroke:var(--rmt-ink)}
.rmt-s-wear{stroke:var(--rmt-wear)}
.rmt-s-leaf{stroke:var(--rmt-leaf)}
.rmt-s-quiet{stroke:var(--ink-2,#8b8f98)}
.rmt-fig,.rmt-eyes,.rmt-look,.rmt-badge,.rmt-z{transform-box:view-box}
.rmt-fig{transform-origin:32px 58px}
.rmt-eyes{transform-origin:32px var(--rmt-eye-y)}
.rmt-badge{transform-origin:54px 11px}
.rmt[data-animate]:not([data-state="sleeping"]) .rmt-eyes{animation:rmt-blink var(--rmt-blink) linear var(--rmt-phase) infinite}
.rmt[data-animate][data-state="idle"] .rmt-fig{animation:rmt-breathe 4.8s ease-in-out var(--rmt-phase) infinite}
.rmt[data-animate][data-state="working"] .rmt-fig{animation:rmt-bob 1.2s cubic-bezier(.45,0,.55,1) infinite}
.rmt[data-animate][data-state="working"] .rmt-look{animation:rmt-scan 3.6s ease-in-out infinite}
.rmt[data-animate][data-state="needs-you"] .rmt-fig{animation:rmt-hop 3.2s ease-out infinite}
.rmt[data-animate][data-state="sleeping"] .rmt-fig{animation:rmt-sleep 5.6s ease-in-out infinite}
.rmt[data-animate][data-state="sleeping"] .rmt-z{animation:rmt-z 5.6s ease-in-out infinite}
@keyframes rmt-blink{0%,94%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}
@keyframes rmt-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,1.028)}}
@keyframes rmt-bob{0%,100%{transform:translateY(0) scale(1,1)}45%{transform:translateY(-2.2px) scale(.985,1.02)}88%{transform:translateY(0) scale(1.025,.97)}}
@keyframes rmt-scan{0%,100%{transform:translate(2px,.8px)}45%,55%{transform:translate(-.6px,.8px)}}
@keyframes rmt-hop{0%,32%,100%{transform:translateY(0) scale(1,1)}6%{transform:translateY(0) scale(1.05,.94)}14%{transform:translateY(-4.5px) scale(.97,1.04)}22%{transform:translateY(0) scale(1.04,.96)}}
@keyframes rmt-sleep{0%,100%{transform:scale(1,1)}50%{transform:scale(1.02,1.035)}}
@keyframes rmt-z{0%{opacity:.25;transform:translate(0,2px)}50%{opacity:1;transform:translate(0,0)}100%{opacity:.25;transform:translate(0,2px)}}
@media (prefers-reduced-motion:reduce){.rmt,.rmt *{animation:none!important}}
:root[data-quiet] .rmt *{animation-play-state:paused!important}
`;

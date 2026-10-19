import { REALM_SEED, deriveVars } from "@realm/ui/src/themes";

/**
 * The shared page's look: Realm's own palette in both faces, and the reading styles that sit on it.
 *
 * The colours are not copied out of tokens.css. They are DERIVED from Realm's seeds the same way the
 * app's themes are (`deriveVars`), and the app's own guardrail holds those seeds to tokens.css — so a
 * page saved today wears the palette the app wears today, and nothing here can drift from it.
 */

/** The palette roles the page uses. Everything else `deriveVars` writes (fills, tooltips, charts) is
 *  app chrome the page does not have. */
const ROLES = [
  "--page", "--canvas", "--surface", "--hover", "--hover-2",
  "--ink", "--ink-2", "--ink-3", "--accent", "--accent-ink", "--accent-tint",
  "--green", "--green-tint", "--orange", "--red", "--red-tint",
  "--syn-fg", "--syn-comment", "--syn-keyword", "--syn-string", "--syn-number", "--syn-title", "--syn-type", "--syn-attr", "--syn-meta", "--syn-deleted",
] as const;

function palette(mode: "light" | "dark"): string {
  const vars = deriveVars(REALM_SEED[mode], mode);
  return ROLES.map((role) => `${role}:${vars[role]}`).join(";");
}

/** The two faces, and which one is worn: the reader's system setting, unless the page's own switch
 *  (the script below) has picked one. Light is the base so a browser that cannot evaluate the media
 *  query, and paper, get the light face. */
function faces(): string {
  const light = palette("light"), dark = palette("dark");
  return [
    `:root{color-scheme:light;${light};--bubble:var(--hover-2);--panel:var(--page);--line:color-mix(in oklab,var(--ink) 11%,transparent)}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;${dark};--bubble:var(--hover);--panel:var(--surface);--line:color-mix(in oklab,var(--ink) 12%,transparent)}}`,
    `:root[data-theme=dark]{color-scheme:dark;${dark};--bubble:var(--hover);--panel:var(--surface);--line:color-mix(in oklab,var(--ink) 12%,transparent)}`,
  ].join("\n");
}

/* The reading styles. Sizes are the page's own ladder — 28 for the title, 20 and 18 for an answer's
   headings, 16 for reading, 14 for the work's lines, 13 for code, 12 for captions — and the app's
   shapes: the prompt a bubble on the right, the answer plain prose on the left, the work quiet lines
   that open. */
const READING = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--canvas);color:var(--ink);font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.65;font-synthesis:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
::selection{background:var(--accent-tint)}
a{color:var(--accent-ink);font-weight:500;text-decoration:none;text-underline-offset:2px}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,pre,kbd{font-family:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-ligatures:none}

.page{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,720px) minmax(0,1fr);padding:72px 32px 56px}
.page>*{grid-column:2}
.head{margin:0 0 48px}
.crumb{margin:0 0 10px;font-size:14px;line-height:20px;color:var(--ink-2);font-weight:500}
h1{margin:0;font-size:28px;line-height:1.2;font-weight:560;letter-spacing:-0.015em;text-wrap:balance;overflow-wrap:anywhere}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,max-content));gap:12px 48px;margin:20px 0 0;padding:0}
.facts>div{min-width:0}
.facts dt{font-size:12px;line-height:16px;color:var(--ink-3)}
.facts dd{margin:2px 0 0;font-size:14px;line-height:20px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.theme{position:absolute;top:20px;right:20px;font:inherit;font-size:13px;line-height:16px;padding:8px 12px;border-radius:8px;border:0;background:transparent;color:var(--ink-2);cursor:pointer}
.theme:hover{background:var(--hover)}
.theme[hidden]{display:none}

.outline{grid-column:1;grid-row:2;justify-self:end;width:200px;display:none}
.outline-in{position:sticky;top:32px;max-height:calc(100vh - 64px);overflow:auto}
.outline ol{list-style:none;margin:0;padding:0}
.outline li{margin:0}
.outline-head{margin:0;padding:5px 0;font-size:12px;line-height:16px;color:var(--ink-3)}
.outline a{display:block;padding:5px 0;font-size:13px;line-height:18px;font-weight:450;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.outline a:hover{color:var(--ink);text-decoration:none}
@media (min-width:1180px){.page{column-gap:48px}.outline{display:block}}

.log{display:flex;flex-direction:column;gap:14px;min-width:0}
.msg{position:relative;min-width:0}
.msg-user{align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(85%,600px);margin-top:28px}
.log>.msg-user:first-child{margin-top:0}
.bubble{padding:12px 16px;border-radius:20px;background:var(--bubble);white-space:pre-wrap;overflow-wrap:anywhere}
.msg-from{margin:0;font-size:12px;line-height:16px;color:var(--ink-3)}
.anchor{position:absolute;top:2px;left:-28px;width:20px;text-align:center;font-size:14px;color:var(--ink-3);opacity:0;transition:opacity .15s ease}
.msg:hover>.anchor,.anchor:focus-visible{opacity:1}
.msg-user>.anchor{left:auto;right:calc(100% + 8px);top:12px}
.anchor:hover{color:var(--accent-ink);text-decoration:none}

.md{min-width:0;overflow-wrap:anywhere}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:0 0 14px;text-wrap:pretty}
.md h3,.md h4,.md h5,.md h6{margin:28px 0 10px;line-height:1.3;font-weight:600;text-wrap:balance}
.md h3{font-size:20px;letter-spacing:-0.01em}.md h4{font-size:18px}.md h5{font-size:16px}.md h6{font-size:16px;color:var(--ink-2)}
.md ul,.md ol{margin:0 0 14px;padding-left:24px}
.md li{margin:4px 0}.md li>p{margin:0 0 6px}
.md li:has(>input[type=checkbox]){list-style:none;margin-left:-22px}
.md input[type=checkbox]{margin:0 8px 0 0;vertical-align:-1px;accent-color:var(--accent)}
.md blockquote{margin:0 0 14px;padding:2px 0 2px 16px;border-left:3px solid var(--line);color:var(--ink-2)}
.md hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.md strong{font-weight:600}
.md :not(pre)>code{font-size:.85em;padding:.15em .4em;border-radius:6px;background:var(--panel);overflow-wrap:anywhere}
.md img,.pic img{display:block;max-width:100%;height:auto;border-radius:8px;outline:1px solid color-mix(in oklab,var(--ink) 10%,transparent);outline-offset:-1px}
.table{margin:0 0 16px;overflow-x:auto;border-radius:12px;background:var(--panel)}
.md table{width:100%;border-collapse:collapse;font-size:14px;line-height:20px}
.md th,.md td{padding:8px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
.md th{font-weight:600;color:var(--ink)}
.md tbody tr:last-child td{border-bottom:0}
.md td[align=right],.md th[align=right]{text-align:right;font-variant-numeric:tabular-nums}
.md td[align=center],.md th[align=center]{text-align:center}
.dead{color:var(--ink-2)}

.code{margin:0 0 16px;border-radius:16px;background:var(--panel);overflow:hidden}
.code figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:0 10px 0 18px;font:12px/16px "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;color:var(--ink-3)}
.code pre{margin:0;padding:2px 18px 16px;overflow-x:auto;font-size:13px;line-height:1.65;color:var(--syn-fg);tab-size:2}
.code figcaption:empty{min-height:14px}
.copy{font:inherit;font-family:"Inter",ui-sans-serif,system-ui,sans-serif;font-size:12px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--ink-2);cursor:pointer}
.copy:hover{background:var(--hover);color:var(--ink)}
.hljs{color:var(--syn-fg)}
.hljs-comment,.hljs-quote{color:var(--syn-comment);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-name{color:var(--syn-keyword)}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:var(--syn-string)}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-link,.hljs-template-variable,.hljs-variable{color:var(--syn-number)}
.hljs-title,.hljs-section,.hljs-title.class_,.hljs-title.function_,.hljs-selector-id{color:var(--syn-title);font-weight:560}
.hljs-type,.hljs-built_in,.hljs-class .hljs-title,.hljs-params{color:var(--syn-type)}
.hljs-attr,.hljs-selector-attr,.hljs-selector-class,.hljs-property{color:var(--syn-attr)}
.hljs-meta,.hljs-comment .hljs-doctag{color:var(--syn-meta)}
.hljs-deletion{color:var(--syn-deleted)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}

details>summary{list-style:none;cursor:pointer}
details>summary::-webkit-details-marker{display:none}
.line{display:flex;align-items:baseline;gap:8px;min-width:0;padding:3px 0;font-size:14px;line-height:22px;color:var(--ink-2)}
summary.line:hover .verb{color:var(--ink)}
.chev{flex:none;width:12px;height:12px;align-self:center;color:var(--ink-3);transition:transform .15s ease}
details[open]>summary .chev{transform:rotate(90deg)}
.dot{flex:none;width:12px;height:12px;align-self:center;display:grid;place-items:center}
.dot::before{content:"";width:4px;height:4px;border-radius:50%;background:var(--ink-3)}
.verb{flex:none;font-weight:500;color:var(--ink-2)}
.obj{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:13px/22px "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;color:var(--ink-2)}
.obj.prose{font:inherit;font-size:14px}
.stat{flex:none;font:12px/22px "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
.add{color:var(--green)}.del{color:var(--red)}
.tag{flex:none;font-size:13px;color:var(--ink-3)}
.tag[data-tone=bad]{color:var(--red)}
.body{margin:6px 0 14px 20px;display:flex;flex-direction:column;gap:10px;min-width:0}
.steps>.body{margin-top:2px;gap:0}
.well{margin:0;padding:12px 14px;border-radius:12px;background:var(--panel);overflow-x:auto;font-size:13px;line-height:1.6;color:var(--syn-fg);white-space:pre}
.well.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.well .cmd{color:var(--ink)}
.well .ps{color:var(--ink-3);user-select:none}
.cap{margin:0;font-size:12px;line-height:16px;color:var(--ink-3)}
.cap[data-tone=bad]{color:var(--red)}
.more{margin:0;font-size:13px;line-height:18px;color:var(--ink-3)}
.args{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0;font-size:13px;line-height:20px}
.args dt{color:var(--ink-3);font-family:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace}
.args dd{margin:0;color:var(--ink-2);overflow-wrap:anywhere;white-space:pre-wrap}
.todo{list-style:none;margin:0;padding:0;font-size:14px;line-height:22px}
.todo li{display:flex;gap:8px;color:var(--ink-2)}
.todo li::before{content:"○";flex:none;width:14px;color:var(--ink-3)}
.todo li[data-status=completed]{color:var(--ink-3);text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--ink-3) 60%,transparent)}
.todo li[data-status=completed]::before{content:"✓";color:var(--green);text-decoration:none}
.todo li[data-status=in_progress]{color:var(--ink)}
.todo li[data-status=in_progress]::before{content:"◐";color:var(--accent)}

.diff{border-radius:12px;background:var(--panel);overflow:hidden}
.diff-head{display:flex;align-items:baseline;gap:10px;padding:9px 14px 7px;font:12px/18px "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;color:var(--ink-2)}
.diff-head .path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.diff-lines{overflow-x:auto;padding:0 0 8px}
.diff table,.listing table{border-collapse:collapse;min-width:100%;font:13px/1.6 "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace}
.diff td,.listing td{padding:0;white-space:pre;vertical-align:top}
.diff .no,.listing .no{width:1%;padding:0 8px 0 14px;text-align:right;color:var(--ink-3);user-select:none;font-variant-numeric:tabular-nums}
.listing{padding:10px 0;border-radius:12px;background:var(--panel);overflow-x:auto}
.listing .no{padding-right:16px}
.listing .text{padding-right:14px;color:var(--syn-fg)}
.diff .sign{width:1%;padding:0 8px 0 4px;color:var(--ink-3);user-select:none}
.diff .text{padding-right:14px;color:var(--syn-fg)}
.diff tr[data-kind=add]{background:var(--green-tint)}
.diff tr[data-kind=add] .sign{color:var(--green)}
.diff tr[data-kind=del]{background:var(--red-tint)}
.diff tr[data-kind=del] .sign{color:var(--red)}
.diff .gap td{padding:2px 14px;color:var(--ink-3);font-family:"Inter",ui-sans-serif,system-ui,sans-serif;font-size:12px}
.diff-note{margin:0;padding:0 14px 10px;font-size:13px;color:var(--ink-3)}

.agent>.body{margin-left:5px;padding-left:18px;border-left:2px solid var(--line);gap:12px}
.agent-label{margin:4px 0 -4px;font-size:12px;line-height:16px;color:var(--ink-3)}
.agent .msg-user{margin-top:8px}
.thinking>.body{color:var(--ink-2);font-size:15px}
.plan{padding:14px 18px;border-radius:16px;background:var(--panel)}
.plan-head{margin:0 0 8px;font-size:13px;line-height:18px;font-weight:600;color:var(--ink-2)}
.plan .md{font-size:15px}
.note{margin:0;font-size:14px;line-height:20px;color:var(--ink-2)}
.note[data-tone=bad]{color:var(--red)}
.note strong{font-weight:600;color:var(--ink)}
.ask{padding:12px 16px;border-radius:12px;background:var(--panel);font-size:14px;line-height:20px}
.ask p{margin:0}.ask p+p{margin-top:6px}
.ask .q{color:var(--ink)}
.ask .a{color:var(--ink-2)}
.run{margin:2px 0 0;font-size:13px;line-height:18px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.files{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin:0;padding:0;list-style:none}
.file{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:6px 12px;border-radius:10px;background:var(--panel);font-size:13px;line-height:18px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pic{margin:0;max-width:100%}
.files .pic img{max-height:320px;width:auto}
.left{display:inline-flex;padding:6px 12px;border-radius:10px;background:var(--panel);font-size:13px;line-height:18px;color:var(--ink-3)}
.secret{font:.85em "JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;padding:.05em .35em;border-radius:5px;background:var(--hover-2);color:var(--ink-2);white-space:nowrap}

.foot{margin-top:72px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;font-size:13px;line-height:18px;color:var(--ink-3)}
.made{display:inline-flex;align-items:center;gap:8px;color:var(--ink-2);font-weight:500}
.made svg{width:16px;height:14px;color:var(--ink-2)}
.foot p{margin:0}

@media (max-width:640px){
  .page{padding:40px 20px 40px}
  .anchor{display:none}
  .head{margin-bottom:36px}
  h1{font-size:24px}
  .facts{grid-template-columns:1fr 1fr;gap:12px 20px}
  .msg-user{max-width:92%}
  .theme{top:8px;right:8px}
  .body{margin-left:10px}
  .code pre{padding:2px 14px 14px}
  .code figcaption{padding-left:14px}
}
@media (prefers-reduced-motion:reduce){.chev,.anchor{transition:none}}
@media print{
  :root{color-scheme:light}
  body{background:#fff}
  .page{display:block;padding:0}
  .theme,.copy,.anchor,.outline{display:none!important}
  .msg-user,.code,.diff,.plan,.ask,.line{break-inside:avoid}
  .well,.code pre,.diff-lines{white-space:pre-wrap;overflow:visible}
  a{color:inherit;text-decoration:underline}
}
`;

export function pageStyle(): string {
  return `${faces()}\n${READING}`;
}

/**
 * The page's only script, and nothing needs it to be read: it adds a copy button to each block of
 * code and a switch between the two faces, remembered in the browser that opened the file.
 *
 * Pinned by hash in the page's Content-Security-Policy (`PAGE_SCRIPT_HASH`), so the page runs THIS
 * and nothing else — whatever a transcript managed to put in it. A test re-hashes it, so an edit
 * here that forgets the hash fails there rather than silently disabling the script.
 */
export const PAGE_SCRIPT = `(()=>{const d=document,r=d.documentElement,K="realm-share-theme",F=["auto","light","dark"],N={auto:"Appearance: auto",light:"Appearance: light",dark:"Appearance: dark"};
const set=t=>{t==="auto"?r.removeAttribute("data-theme"):r.setAttribute("data-theme",t);const b=d.querySelector(".theme");if(b)b.textContent=N[t]};
let t="auto";try{t=localStorage.getItem(K)||"auto"}catch(e){}if(!F.includes(t))t="auto";set(t);
const b=d.querySelector(".theme");if(b){b.hidden=false;b.addEventListener("click",()=>{t=F[(F.indexOf(t)+1)%3];set(t);try{localStorage.setItem(K,t)}catch(e){}})}
for(const f of d.querySelectorAll("figure.code")){const c=f.querySelector("figcaption"),code=f.querySelector("code");if(!c||!code)continue;const x=d.createElement("button");x.type="button";x.className="copy";x.textContent="Copy";
x.addEventListener("click",()=>{const s=code.innerText,done=()=>{x.textContent="Copied";setTimeout(()=>{x.textContent="Copy"},1400)};
const old=()=>{const a=d.createElement("textarea");a.value=s;a.style.position="fixed";a.style.opacity="0";d.body.append(a);a.select();try{d.execCommand("copy");done()}finally{a.remove()}};
navigator.clipboard&&window.isSecureContext?navigator.clipboard.writeText(s).then(done,old):old()});c.append(x)}})();`;

/** `sha256-…` of `PAGE_SCRIPT`, as the policy names it. share-page.test.ts recomputes it. */
export const PAGE_SCRIPT_HASH = "sha256-ijSusCaVVsleg0G2Fe94DcPl8FcuuKFdWMUJasqrue8=";

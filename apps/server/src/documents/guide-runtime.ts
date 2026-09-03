/**
 * The study-guide runtime (Plan 22 W1): the script and stylesheet the preview server injects into
 * every `.html` document it serves.
 *
 * Kept as string constants in the server bundle rather than as files on disk, so the packaged app
 * needs no asset copying and a dev checkout and a DMG serve byte-identical runtimes. The whole thing
 * is deliberately dependency-free vanilla JS: it runs inside a sandboxed frame with a strict CSP
 * (no network, no eval), and a guide author — usually an agent — only has to write markup.
 *
 * The markup contract, which `skills/study-guide/SKILL.md` teaches:
 *
 *   <section class="rg-quiz" data-topic="cache-coherence">
 *     <div class="rg-question" data-answer="b">          ← letter (a, b, …), 1-based index, or "a,c"
 *       <p>Question text</p>
 *       <ol class="rg-options"><li>…</li><li>…</li></ol>  ← options; clicking selects
 *       <div class="rg-explain">Shown after checking</div>
 *     </div>
 *     <div class="rg-question" data-answer="MESI|mesi">   ← short answer: any of the `|` alternatives
 *       <p>Question text</p><input class="rg-input">
 *     </div>
 *     <button class="rg-check">Check answers</button>
 *   </section>
 *
 *   <div class="rg-steps"><div class="rg-step">…</div>…</div>        ← one at a time, Prev/Next, ←/→
 *   <details class="rg-reveal"><summary>Show answer</summary>…</details>
 *   <div class="rg-flashcards"><div class="rg-card"><div class="rg-front">Q</div><div class="rg-back">A</div></div></div>
 *
 * Math: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` render through KaTeX when the document opts in with
 * `<meta name="realm-helpers" content="katex">` (the server injects KaTeX only then — it is 300 kB).
 *
 * Progress: after "Check answers" the runtime posts `{type:"realm-guide:attempt", topic, correct,
 * total}` to the pane, which folds it into the guide's sidecar and answers with
 * `{type:"realm-guide:progress", progress}`; the runtime shows best/last per topic. The frame's
 * origin is opaque, so this bridge is the ONLY persistence a guide has.
 */

export const GUIDE_JS = String.raw`(function () {
  "use strict";
  var LETTERS = "abcdefghijklmnopqrstuvwxyz";
  var progress = { version: 1, topics: {} };

  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }

  // ---- answers -----------------------------------------------------------------------------
  function parseAnswer(spec, count) {
    var out = {};
    String(spec || "").split(",").forEach(function (part) {
      var p = part.trim().toLowerCase();
      if (!p) return;
      var n = /^\d+$/.test(p) ? parseInt(p, 10) - 1 : LETTERS.indexOf(p);
      if (n >= 0 && n < count) out[n] = true;
    });
    return out;
  }
  function norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

  function setupQuestion(q) {
    var options = q.querySelectorAll(".rg-options > li");
    var input = q.querySelector(".rg-input");
    if (options.length) {
      var answer = parseAnswer(q.getAttribute("data-answer"), options.length);
      var multi = Object.keys(answer).length > 1;
      q.setAttribute("data-multi", multi ? "true" : "false");
      Array.prototype.forEach.call(options, function (li, i) {
        li.setAttribute("tabindex", "0");
        li.setAttribute("role", multi ? "checkbox" : "radio");
        li.setAttribute("aria-checked", "false");
        var pick = function () {
          if (q.getAttribute("data-checked") === "true") return;
          if (multi) {
            var on = li.getAttribute("aria-checked") === "true";
            li.setAttribute("aria-checked", on ? "false" : "true");
          } else {
            Array.prototype.forEach.call(options, function (o) { o.setAttribute("aria-checked", "false"); });
            li.setAttribute("aria-checked", "true");
          }
        };
        li.addEventListener("click", pick);
        li.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); pick(); } });
      });
      return function grade() {
        var correct = true, any = false;
        Array.prototype.forEach.call(options, function (li, i) {
          var picked = li.getAttribute("aria-checked") === "true";
          if (picked) any = true;
          var right = !!answer[i];
          li.setAttribute("data-result", right ? "correct" : picked ? "incorrect" : "");
          if (picked !== right) correct = false;
        });
        if (!any) correct = false;
        q.setAttribute("data-checked", "true");
        q.setAttribute("data-result", correct ? "correct" : "incorrect");
        var ex = q.querySelector(".rg-explain"); if (ex) ex.setAttribute("data-open", "true");
        return correct;
      };
    }
    if (input) {
      var accepted = String(q.getAttribute("data-answer") || "").split("|").map(norm).filter(Boolean);
      return function grade() {
        var ok = accepted.indexOf(norm(input.value)) >= 0;
        q.setAttribute("data-checked", "true");
        q.setAttribute("data-result", ok ? "correct" : "incorrect");
        input.setAttribute("readonly", "readonly");
        var ex = q.querySelector(".rg-explain"); if (ex) ex.setAttribute("data-open", "true");
        if (!ok && accepted.length) {
          var a = document.createElement("div"); a.className = "rg-answer";
          a.textContent = "Answer: " + String(q.getAttribute("data-answer") || "").split("|")[0];
          q.appendChild(a);
        }
        return ok;
      };
    }
    return null;
  }

  function renderBadge(quiz) {
    var topic = quiz.getAttribute("data-topic") || "";
    var t = progress.topics[topic];
    var badge = quiz.querySelector(".rg-progress");
    if (!badge) { badge = document.createElement("div"); badge.className = "rg-progress"; quiz.insertBefore(badge, quiz.firstChild); }
    if (!t || !t.attempts || !t.attempts.length) { badge.textContent = "Not attempted yet"; badge.setAttribute("data-state", "none"); return; }
    var pct = function (x) { return Math.round(x * 100) + "%"; };
    badge.textContent = "Best " + pct(t.best) + " · Last " + pct(t.last) + " · " + t.attempts.length + (t.attempts.length === 1 ? " attempt" : " attempts");
    badge.setAttribute("data-state", t.last >= 0.8 ? "good" : "weak");
  }

  function setupQuiz(quiz) {
    var topic = quiz.getAttribute("data-topic") || "";
    var graders = [];
    Array.prototype.forEach.call(quiz.querySelectorAll(".rg-question"), function (q) {
      var g = setupQuestion(q); if (g) graders.push(g);
    });
    renderBadge(quiz);
    var button = quiz.querySelector(".rg-check");
    if (!button) return;
    button.addEventListener("click", function () {
      if (quiz.getAttribute("data-checked") === "true") { // retake
        location.reload(); return;
      }
      var correct = 0;
      graders.forEach(function (g) { if (g()) correct++; });
      var total = graders.length;
      quiz.setAttribute("data-checked", "true");
      var score = quiz.querySelector(".rg-score");
      if (!score) { score = document.createElement("div"); score.className = "rg-score"; button.parentNode.insertBefore(score, button); }
      score.textContent = correct + " / " + total + " correct";
      score.setAttribute("data-state", total && correct / total >= 0.8 ? "good" : "weak");
      button.textContent = "Retake";
      if (total > 0) post({ type: "realm-guide:attempt", topic: topic, correct: correct, total: total });
    });
  }

  // ---- steps -------------------------------------------------------------------------------
  function setupSteps(box) {
    var steps = box.querySelectorAll(":scope > .rg-step");
    if (!steps.length) return;
    var i = 0;
    var nav = document.createElement("div"); nav.className = "rg-steps-nav";
    var prev = document.createElement("button"); prev.type = "button"; prev.textContent = "← Prev";
    var next = document.createElement("button"); next.type = "button"; next.textContent = "Next →";
    var counter = document.createElement("span"); counter.className = "rg-steps-counter";
    nav.appendChild(prev); nav.appendChild(counter); nav.appendChild(next);
    box.appendChild(nav);
    function show() {
      Array.prototype.forEach.call(steps, function (s, k) { s.setAttribute("data-active", k === i ? "true" : "false"); });
      counter.textContent = "Step " + (i + 1) + " of " + steps.length;
      prev.disabled = i === 0; next.disabled = i === steps.length - 1;
    }
    prev.addEventListener("click", function () { if (i > 0) { i--; show(); } });
    next.addEventListener("click", function () { if (i < steps.length - 1) { i++; show(); } });
    box.setAttribute("tabindex", "0");
    box.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft" && i > 0) { i--; show(); e.preventDefault(); }
      if (e.key === "ArrowRight" && i < steps.length - 1) { i++; show(); e.preventDefault(); }
    });
    show();
  }

  // ---- flashcards --------------------------------------------------------------------------
  function setupCards(box) {
    Array.prototype.forEach.call(box.querySelectorAll(".rg-card"), function (card) {
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      var flip = function () { card.setAttribute("data-flipped", card.getAttribute("data-flipped") === "true" ? "false" : "true"); };
      card.addEventListener("click", flip);
      card.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
    });
  }

  // ---- math --------------------------------------------------------------------------------
  function renderMath() {
    if (typeof window.renderMathInElement !== "function") return;
    try {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
          { left: "$", right: "$", display: false },
        ],
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
        throwOnError: false,
      });
    } catch (e) {}
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(".rg-quiz"), setupQuiz);
    Array.prototype.forEach.call(document.querySelectorAll(".rg-steps"), setupSteps);
    Array.prototype.forEach.call(document.querySelectorAll(".rg-flashcards"), setupCards);
    renderMath();
    post({ type: "realm-guide:ready" });
  }

  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d || d.type !== "realm-guide:progress" || !d.progress || !d.progress.topics) return;
    progress = d.progress;
    Array.prototype.forEach.call(document.querySelectorAll(".rg-quiz"), renderBadge);
  });

  window.Realm = {
    attempt: function (topic, correct, total) { post({ type: "realm-guide:attempt", topic: String(topic), correct: Number(correct), total: Number(total) }); },
    progress: function () { return progress; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
`;

export const GUIDE_CSS = String.raw`
:root {
  --rg-bg: #ffffff; --rg-fg: #1c1c1e; --rg-muted: #6e6e73; --rg-line: #e5e5ea; --rg-raised: #f5f5f7;
  --rg-accent: #5b5bd6; --rg-good: #1f8a4c; --rg-good-bg: #e6f6ec; --rg-bad: #c4322d; --rg-bad-bg: #fbeae9;
  --rg-radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rg-bg: #161618; --rg-fg: #ececf1; --rg-muted: #9a9aa3; --rg-line: #2c2c31; --rg-raised: #1f1f23;
    --rg-accent: #8b8bff; --rg-good: #4cc38a; --rg-good-bg: #12301f; --rg-bad: #ff6b6b; --rg-bad-bg: #3a1c1c;
  }
}
html { background: var(--rg-bg); color: var(--rg-fg); }
body {
  margin: 0; padding: 28px 20px 60px; font: 15.5px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.rg-guide, main { max-width: 760px; margin: 0 auto; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 12px; letter-spacing: -0.01em; }
h2 { font-size: 19px; margin: 32px 0 10px; }
h3 { font-size: 16px; margin: 22px 0 8px; }
p, ul, ol { margin: 0 0 12px; }
a { color: var(--rg-accent); }
code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--rg-raised); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--rg-raised); border: 1px solid var(--rg-line); border-radius: var(--rg-radius); padding: 12px 14px; overflow: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 0 0 14px; font-size: 14px; }
th, td { border: 1px solid var(--rg-line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--rg-raised); }
img, svg { max-width: 100%; }
.rg-lede { color: var(--rg-muted); font-size: 16px; }
.rg-sources { margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--rg-line); color: var(--rg-muted); font-size: 13.5px; }
.rg-sources h2 { font-size: 14px; margin: 0 0 6px; color: var(--rg-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.rg-callout { border-left: 3px solid var(--rg-accent); background: var(--rg-raised); padding: 10px 14px; border-radius: 0 var(--rg-radius) var(--rg-radius) 0; margin: 0 0 14px; }

/* quiz */
.rg-quiz { border: 1px solid var(--rg-line); border-radius: var(--rg-radius); padding: 16px 18px 14px; margin: 18px 0; background: var(--rg-raised); position: relative; }
.rg-quiz h2, .rg-quiz h3 { margin-top: 0; }
.rg-progress { position: absolute; top: 12px; right: 14px; font-size: 12px; color: var(--rg-muted); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--rg-line); background: var(--rg-bg); }
.rg-progress[data-state="good"] { color: var(--rg-good); border-color: var(--rg-good); }
.rg-progress[data-state="weak"] { color: var(--rg-bad); border-color: var(--rg-bad); }
.rg-question { padding: 10px 0 12px; border-top: 1px solid var(--rg-line); }
.rg-question:first-of-type { border-top: 0; }
.rg-question > p:first-child { font-weight: 600; margin-bottom: 8px; }
.rg-options { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.rg-options > li {
  padding: 8px 12px; border: 1px solid var(--rg-line); border-radius: 8px; background: var(--rg-bg); cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.rg-options > li:hover { border-color: var(--rg-accent); }
.rg-options > li[aria-checked="true"] { border-color: var(--rg-accent); box-shadow: inset 0 0 0 1px var(--rg-accent); }
.rg-question[data-checked="true"] .rg-options > li { cursor: default; }
.rg-options > li[data-result="correct"] { border-color: var(--rg-good); background: var(--rg-good-bg); }
.rg-options > li[data-result="incorrect"] { border-color: var(--rg-bad); background: var(--rg-bad-bg); }
.rg-input { font: inherit; padding: 6px 10px; border: 1px solid var(--rg-line); border-radius: 8px; background: var(--rg-bg); color: var(--rg-fg); width: 100%; max-width: 360px; box-sizing: border-box; }
.rg-question[data-result="correct"] .rg-input { border-color: var(--rg-good); background: var(--rg-good-bg); }
.rg-question[data-result="incorrect"] .rg-input { border-color: var(--rg-bad); background: var(--rg-bad-bg); }
.rg-answer { margin-top: 6px; font-size: 13.5px; color: var(--rg-good); }
.rg-explain { display: none; margin-top: 8px; padding: 8px 12px; border-radius: 8px; background: var(--rg-bg); border: 1px dashed var(--rg-line); font-size: 14px; color: var(--rg-muted); }
.rg-explain[data-open="true"] { display: block; }
.rg-check {
  font: inherit; font-size: 14px; font-weight: 600; padding: 7px 14px; border-radius: 8px; border: 0; cursor: pointer;
  background: var(--rg-accent); color: #fff; margin-top: 8px;
}
.rg-score { display: inline-block; margin: 8px 12px 0 0; font-weight: 600; }
.rg-score[data-state="good"] { color: var(--rg-good); }
.rg-score[data-state="weak"] { color: var(--rg-bad); }

/* steps */
.rg-steps { border: 1px solid var(--rg-line); border-radius: var(--rg-radius); padding: 14px 18px; margin: 18px 0; outline: none; }
.rg-steps:focus-visible { box-shadow: 0 0 0 2px var(--rg-accent); }
.rg-step { display: none; }
.rg-step[data-active="true"] { display: block; }
.rg-steps-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--rg-line); }
.rg-steps-nav button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--rg-line); background: var(--rg-bg); color: var(--rg-fg); cursor: pointer; }
.rg-steps-nav button:disabled { opacity: 0.4; cursor: default; }
.rg-steps-counter { font-size: 13px; color: var(--rg-muted); }

/* reveal */
details.rg-reveal { border: 1px solid var(--rg-line); border-radius: 8px; padding: 8px 12px; margin: 10px 0; background: var(--rg-raised); }
details.rg-reveal > summary { cursor: pointer; font-weight: 600; color: var(--rg-accent); }

/* flashcards */
.rg-flashcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin: 14px 0; }
.rg-card { border: 1px solid var(--rg-line); border-radius: var(--rg-radius); background: var(--rg-raised); min-height: 110px; padding: 14px; cursor: pointer; outline: none; position: relative; }
.rg-card:focus-visible { box-shadow: 0 0 0 2px var(--rg-accent); }
.rg-card .rg-back { display: none; }
.rg-card[data-flipped="true"] .rg-front { display: none; }
.rg-card[data-flipped="true"] .rg-back { display: block; }
.rg-card::after { content: "tap to flip"; position: absolute; right: 10px; bottom: 6px; font-size: 11px; color: var(--rg-muted); }
.rg-card[data-flipped="true"]::after { content: "tap to flip back"; }
`;

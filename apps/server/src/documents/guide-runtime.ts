import { GUIDE_STATE_MARK, GUIDE_STORAGE_MAX_CHARS } from "@realm/contracts";

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
 * `{type:"realm-guide:progress", progress}`; the runtime shows best/last per topic.
 *
 * Reading position rides the same bridge. The frame is cross-origin, so the pane cannot read its
 * scroller and `scroll-memory.ts` — which works by touching the element — has nothing to attach to.
 * Instead the runtime posts `{type:"realm-guide:scroll", top}` as the reader moves and applies a
 * `top` sent back to it, which makes the guide the one framed preview that can come back where it
 * was left. A PDF cannot do this: Chromium renders it in a nested viewer that runs no script of ours.
 *
 * And so does everything else the reader was in the middle of. Every switch that unmounts the frame —
 * another file's tab, another session, another space — reloads the guide from nothing, so whatever
 * lives only in the page is gone: answers picked, a quiz checked, the step a walkthrough was on, a
 * flipped card, a section opened, and — for a guide with a script of its own — the progress it keeps
 * in `localStorage`, which an opaque origin does not have (the guide's write throws, and the usual
 * `catch` keeps it in a variable that dies with the page). So the runtime takes a snapshot as the
 * reader works (`realm-guide:state`), the pane keeps it per guide (`guide-state.ts` in the renderer),
 * and it comes back with the frame. See GUIDE_BOOT for how it arrives before the guide's own scripts.
 */

/**
 * The first script in every guide, inline at the top of its head, so it runs before ANY of the
 * guide's own: a guide's script reads its storage the moment it runs, and anything handed over later
 * by `postMessage` would arrive after the guide had already started from nothing.
 *
 * What it is handed arrives in the frame's `name`. The pane creates the frame with the envelope as
 * its name, the one thing a document can read synchronously from its embedder; the boot takes it only
 * when the envelope names THIS document (a link to another guide loads in the same frame, under the
 * same name). It keeps the name current as the guide changes, because a page's own reload keeps the
 * frame and its name — a quiz's Retake, a course resetting a lesson — and must come back with what
 * was there an instant before, not with what the pane handed over when the frame was made.
 *
 * Then it stands in the two storages the sandbox withholds, as plain objects inside the snapshot,
 * and puts back the guide's own route (`location.hash`, which a single-page guide steers by) before
 * the guide reads it. A guide that is shown somewhere storage works keeps the real one.
 */
export const GUIDE_BOOT = String.raw`(function () {
  "use strict";
  var MARK = ${JSON.stringify(GUIDE_STATE_MARK)}, QUOTA = ${GUIDE_STORAGE_MAX_CHARS};
  var doc = "";
  try { doc = decodeURIComponent(location.pathname).replace(/^\/p\/[^\/]+\//, ""); } catch (e) {}
  var seed = null;
  try {
    var env = JSON.parse(window.name || "null");
    if (env && env.k === MARK && env.doc === doc && env.state && typeof env.state === "object") seed = env.state;
  } catch (e) {}
  var state = { v: 1 };
  if (seed) Object.keys(seed).forEach(function (k) { state[k] = seed[k]; });
  if (seed && typeof seed.hash === "string" && /^#./.test(seed.hash) && !location.hash) {
    try { history.replaceState(history.state, "", seed.hash); } catch (e) {}
  }
  var listeners = [], touched = false;
  function write() { try { window.name = JSON.stringify({ k: MARK, doc: doc, state: state }); } catch (e) {} }
  function post() { try { window.parent.postMessage({ type: "realm-guide:state", doc: doc, state: state }, "*"); } catch (e) {} }
  function changed() {
    write();
    // Until the runtime proper has loaded, the snapshot is this; after, it takes the widgets too.
    if (listeners.length) listeners.forEach(function (fn) { fn(); }); else post();
  }
  function stand(name, field) {
    try { window[name].getItem("realm"); return; } catch (e) {}
    var data = Object.create(null), held = state[field];
    if (held && typeof held === "object") Object.keys(held).forEach(function (k) { if (typeof held[k] === "string") data[k] = held[k]; });
    state[field] = data;
    var used = function (skip) { var n = 0; for (var k in data) if (k !== skip) n += k.length + data[k].length; return n; };
    var api = {
      getItem: function (k) { touched = true; k = String(k); return k in data ? data[k] : null; },
      setItem: function (k, v) {
        touched = true; k = String(k); v = String(v);
        if (used(k) + k.length + v.length > QUOTA) throw new DOMException("This guide's " + name + " is full.", "QuotaExceededError");
        if (data[k] === v) return;
        data[k] = v; changed();
      },
      removeItem: function (k) { touched = true; k = String(k); if (!(k in data)) return; delete data[k]; changed(); },
      clear: function () { touched = true; var had = false; for (var k in data) { delete data[k]; had = true; } if (had) changed(); },
      key: function (i) { var ks = Object.keys(data); return i >= 0 && i < ks.length ? ks[i] : null; },
    };
    Object.defineProperty(api, "length", { configurable: true, get: function () { return Object.keys(data).length; } });
    // A Storage answers to its keys as properties too — localStorage.best = "3" — so a proxy does.
    var store = new Proxy(api, {
      get: function (t, p) { if (typeof p !== "string" || p in t) return t[p]; touched = true; return p in data ? data[p] : undefined; },
      set: function (t, p, v) { if (typeof p !== "string" || p in t) t[p] = v; else api.setItem(p, v); return true; },
      deleteProperty: function (t, p) { if (typeof p === "string" && !(p in t)) api.removeItem(p); return true; },
      has: function (t, p) { return p in t || (typeof p === "string" && p in data); },
      ownKeys: function () { return Object.keys(data); },
      getOwnPropertyDescriptor: function (t, p) {
        return typeof p === "string" && p in data ? { value: data[p], writable: true, enumerable: true, configurable: true } : undefined;
      },
    });
    try { Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return store; } }); } catch (e) {}
  }
  stand("localStorage", "local");
  stand("sessionStorage", "session");
  Object.defineProperty(window, "__realmGuide", { value: {
    doc: doc, seed: seed, state: state, write: write, post: post,
    touched: function () { return touched; },
    onChange: function (fn) { listeners.push(fn); },
  } });
})();
`;

export const GUIDE_JS = String.raw`(function () {
  "use strict";
  var LETTERS = "abcdefghijklmnopqrstuvwxyz";
  var MARK = ${JSON.stringify(GUIDE_STATE_MARK)};
  var progress = { version: 1, topics: {} };
  // The boot's hand-off. Absent only where the page was served without it; the runtime then works
  // as it always did and keeps nothing.
  var boot = window.__realmGuide || null;
  var doc = boot ? boot.doc : "";
  var state = boot ? boot.state : { v: 1 };
  var seed = boot ? boot.seed : null;
  /** Each widget the reader can change, with the key it is kept under: its kind, its place among its
   *  kind, and a signature of its markup as the page was loaded. */
  var widgets = [];
  var interacted = false;

  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }

  /** FNV-1a, base 36: a short, stable fingerprint of a widget's markup. */
  function sig(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }

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

  function explainOf(q) { return q.querySelector(".rg-explain"); }

  /** One question's controls: grade it, read and set what was answered, and clear it for a retake. */
  function setupQuestion(q) {
    var options = q.querySelectorAll(".rg-options > li");
    var input = q.querySelector(".rg-input");
    var clearMarks = function () {
      q.removeAttribute("data-checked"); q.removeAttribute("data-result");
      var ex = explainOf(q); if (ex) ex.removeAttribute("data-open");
    };
    if (options.length) {
      var answer = parseAnswer(q.getAttribute("data-answer"), options.length);
      var multi = Object.keys(answer).length > 1;
      q.setAttribute("data-multi", multi ? "true" : "false");
      Array.prototype.forEach.call(options, function (li) {
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
      return {
        grade: function () {
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
          var ex = explainOf(q); if (ex) ex.setAttribute("data-open", "true");
          return correct;
        },
        get: function () {
          var picked = [];
          Array.prototype.forEach.call(options, function (li, i) { if (li.getAttribute("aria-checked") === "true") picked.push(i); });
          return picked;
        },
        set: function (v) {
          var picked = Array.isArray(v) ? v : [];
          if (!multi) picked = picked.slice(0, 1);
          Array.prototype.forEach.call(options, function (li, i) { li.setAttribute("aria-checked", picked.indexOf(i) >= 0 ? "true" : "false"); });
        },
        reset: function () {
          Array.prototype.forEach.call(options, function (li) { li.setAttribute("aria-checked", "false"); li.removeAttribute("data-result"); });
          clearMarks();
        },
      };
    }
    if (input) {
      var accepted = String(q.getAttribute("data-answer") || "").split("|").map(norm).filter(Boolean);
      return {
        grade: function () {
          var ok = accepted.indexOf(norm(input.value)) >= 0;
          q.setAttribute("data-checked", "true");
          q.setAttribute("data-result", ok ? "correct" : "incorrect");
          input.setAttribute("readonly", "readonly");
          var ex = explainOf(q); if (ex) ex.setAttribute("data-open", "true");
          if (!ok && accepted.length) {
            var a = document.createElement("div"); a.className = "rg-answer";
            a.textContent = "Answer: " + String(q.getAttribute("data-answer") || "").split("|")[0];
            q.appendChild(a);
          }
          return ok;
        },
        get: function () { return input.value; },
        set: function (v) { input.value = typeof v === "string" ? v : ""; },
        reset: function () {
          input.value = ""; input.removeAttribute("readonly");
          Array.prototype.forEach.call(q.querySelectorAll(".rg-answer"), function (a) { a.remove(); });
          clearMarks();
        },
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

  /** A quiz's state is every answer in it and whether it was checked. Checked again on a restore,
   *  quietly: the attempt was recorded when the reader checked it, and a restore is not an attempt. */
  function setupQuiz(quiz) {
    var topic = quiz.getAttribute("data-topic") || "";
    var questions = [];
    Array.prototype.forEach.call(quiz.querySelectorAll(".rg-question"), function (q) {
      var x = setupQuestion(q); if (x) questions.push(x);
    });
    renderBadge(quiz);
    var button = quiz.querySelector(".rg-check");
    var label = button ? button.textContent : "";
    var checked = function () { return quiz.getAttribute("data-checked") === "true"; };
    function check(quiet) {
      var correct = 0;
      questions.forEach(function (x) { if (x.grade()) correct++; });
      var total = questions.length;
      quiz.setAttribute("data-checked", "true");
      if (button) {
        var score = quiz.querySelector(".rg-score");
        if (!score) { score = document.createElement("div"); score.className = "rg-score"; button.parentNode.insertBefore(score, button); }
        score.textContent = correct + " / " + total + " correct";
        score.setAttribute("data-state", total && correct / total >= 0.8 ? "good" : "weak");
        button.textContent = "Retake";
      }
      if (!quiet && total > 0) post({ type: "realm-guide:attempt", topic: topic, correct: correct, total: total });
    }
    // A retake clears this quiz where it stands. It used to reload the page, which now would bring
    // the checked quiz straight back, and cleared every other quiz's answers on the way.
    function reset() {
      questions.forEach(function (x) { x.reset(); });
      quiz.removeAttribute("data-checked");
      var score = quiz.querySelector(".rg-score"); if (score) score.remove();
      if (button) button.textContent = label;
    }
    if (button) button.addEventListener("click", function () { if (checked()) reset(); else check(false); });
    return {
      get: function () {
        var a = questions.map(function (x) { return x.get(); });
        var any = a.some(function (v) { return Array.isArray(v) ? v.length > 0 : v !== ""; });
        return any || checked() ? { a: a, k: checked() ? 1 : 0 } : null;
      },
      set: function (v) {
        if (!v || !Array.isArray(v.a)) return;
        questions.forEach(function (x, i) { if (i < v.a.length) x.set(v.a[i]); });
        if (v.k) check(true);
      },
    };
  }

  // ---- steps -------------------------------------------------------------------------------
  function setupSteps(box) {
    var steps = box.querySelectorAll(":scope > .rg-step");
    if (!steps.length) return null;
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
    return {
      get: function () { return i > 0 ? i : null; },
      set: function (v) { if (typeof v === "number" && v >= 0) { i = Math.min(Math.floor(v), steps.length - 1); show(); } },
    };
  }

  // ---- flashcards --------------------------------------------------------------------------
  function setupCard(card) {
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    var flipped = function () { return card.getAttribute("data-flipped") === "true"; };
    var flip = function () { card.setAttribute("data-flipped", flipped() ? "false" : "true"); };
    card.addEventListener("click", flip);
    card.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
    return {
      get: function () { return flipped() ? 1 : null; },
      set: function (v) { card.setAttribute("data-flipped", v ? "true" : "false"); },
    };
  }

  // ---- sections ----------------------------------------------------------------------------
  // Every <details>, not only the runtime's reveals: a worked solution opened in a guide with a
  // script of its own is the same thing to lose. Kept only where it differs from how it was written.
  function setupDetails(d) {
    var initially = d.open;
    return {
      get: function () { return d.open === initially ? null : d.open ? 1 : 0; },
      set: function (v) { d.open = !!v; },
    };
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

  // ---- what the reader was doing -----------------------------------------------------------
  var offset = function () { return Math.round(window.scrollY || document.documentElement.scrollTop || 0); };

  function snapshot() {
    var w = {};
    widgets.forEach(function (x) {
      var v = null;
      try { v = x.get(); } catch (e) {}
      if (v !== null && v !== undefined) w[x.key] = v;
    });
    state.widgets = w;
    state.hash = location.hash || "";
    state.top = offset();
    if (boot) boot.write();
    post({ type: "realm-guide:state", doc: doc, state: state });
  }
  var pending = null;
  // A little after the event, so the page's own handlers — a route a click changed — have run.
  function soon() { if (pending === null) pending = setTimeout(function () { pending = null; snapshot(); }, 60); }

  /** Put back what was kept, widget by widget. A key carries its widget's signature, so a quiz an
   *  agent has since rewritten has a different key and its old answers are never laid onto it; the
   *  rest of the guide still comes back. */
  function apply(s) {
    var w = s && s.widgets && typeof s.widgets === "object" ? s.widgets : {};
    widgets.forEach(function (x) {
      if (!Object.prototype.hasOwnProperty.call(w, x.key)) return;
      try { x.set(w[x.key]); } catch (e) {}
    });
  }

  /** Put the reader at top. The document can be shorter than the offset for a moment — KaTeX and
   *  images land after load — and a page's own script may scroll on load (a course scrolls to its
   *  newest card), so the place is held for a second, and given up the moment the reader moves. */
  function landAt(top) {
    if (typeof top !== "number" || top <= 0) return;
    var until = Date.now() + 1000, stop = false;
    var quit = function () { stop = true; };
    ["wheel", "keydown", "pointerdown", "touchstart"].forEach(function (t) { window.addEventListener(t, quit, { once: true, passive: true, capture: true }); });
    (function hold() {
      if (stop || Date.now() > until) return;
      if (Math.abs((window.scrollY || 0) - top) > 1) window.scrollTo(0, top);
      requestAnimationFrame(hold);
    })();
  }

  function nonEmpty(o) { return !!o && typeof o === "object" && Object.keys(o).length > 0; }

  /** The pane's copy, sent when the frame came up with nothing (see the ready message). */
  function restoreLate(s) {
    if (seed || interacted || !s || typeof s !== "object") return;
    if (boot && (nonEmpty(s.local) || nonEmpty(s.session))) {
      if (boot.touched()) {
        // The guide has already read its storage, empty, and would write that back over this on its
        // next save. It has to start again with the real one, so: load again, with it in hand.
        try { window.name = JSON.stringify({ k: MARK, doc: doc, state: s }); } catch (e) { return; }
        location.reload();
        return;
      }
      ["local", "session"].forEach(function (f) {
        if (!nonEmpty(s[f]) || !state[f]) return;
        Object.keys(s[f]).forEach(function (k) { if (typeof s[f][k] === "string") state[f][k] = s[f][k]; });
      });
    }
    seed = s;
    apply(s);
    if (typeof s.hash === "string" && /^#./.test(s.hash) && !location.hash) { try { location.hash = s.hash; } catch (e) {} }
    landAt(s.top);
    snapshot();
  }

  function init() {
    // Signatures first, from the page as it was written — before setup adds its buttons and badges
    // and before KaTeX rewrites the math.
    var plan = [];
    var each = function (sel, kind, make) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (el, i) {
        plan.push({ key: kind + i + ":" + sig(el.outerHTML), el: el, make: make });
      });
    };
    each(".rg-quiz", "q", setupQuiz);
    each(".rg-steps", "s", setupSteps);
    each(".rg-flashcards .rg-card", "c", setupCard);
    each("details", "d", setupDetails);
    plan.forEach(function (p) { var x = p.make(p.el); if (x) widgets.push({ key: p.key, get: x.get, set: x.set }); });
    if (seed) apply(seed);
    renderMath();
    if (seed) landAt(seed.top);

    ["click", "input", "change", "keydown", "toggle"].forEach(function (t) { document.addEventListener(t, soon, true); });
    ["wheel", "pointerdown", "keydown", "touchstart"].forEach(function (t) { window.addEventListener(t, function () { interacted = true; }, { capture: true, passive: true }); });
    window.addEventListener("hashchange", soon);
    window.addEventListener("popstate", soon);
    window.addEventListener("pagehide", snapshot);
    if (boot) boot.onChange(snapshot);
    // Coalesced to a frame: a scroll fires per wheel notch, and one postMessage per notch would be
    // hundreds of messages to carry a number only the last of which matters.
    var scrolling = false;
    window.addEventListener("scroll", function () {
      if (scrolling) return;
      scrolling = true;
      requestAnimationFrame(function () {
        scrolling = false;
        state.top = offset();
        if (boot) boot.write();
        post({ type: "realm-guide:scroll", top: state.top });
      });
    }, { passive: true });
    // seeded tells the pane it need send nothing back: this page started from what it was handed.
    post({ type: "realm-guide:ready", doc: doc, seeded: !!seed });
    // And the pane hears where the page now stands, which after a page's own reload is newer than
    // its copy, and has shed the answers to any widget that no longer exists.
    if (seed) snapshot();
  }

  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d) return;
    if (d.type === "realm-guide:scroll") { landAt(d.top); return; }
    if (d.type === "realm-guide:restore") { restoreLate(d.state); return; }
    if (d.type !== "realm-guide:progress" || !d.progress || !d.progress.topics) return;
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

import { afterEach, describe, expect, it } from "vitest";
import { PICK_HTML_MAX } from "@realm/contracts";
import { APP_PICKER_ATTR, accessibleName, componentChain, describeAppElement, hooksOf, markupOf, pickTarget, roleOf, selectorFor } from "./describe";

afterEach(() => { document.body.innerHTML = ""; });

const $ = (sel: string) => document.querySelector(sel)!;
const mount = (html: string) => { document.body.innerHTML = `<div id="root">${html}</div>`; };

/** A React fiber the way react-dom leaves one on a node it rendered: the host's own, then up its
 *  `return` chain through the components that rendered it. */
function fiberOn(el: Element, ...types: unknown[]) {
  let up: { type: unknown; return: unknown } | null = null;
  for (const type of [...types].reverse()) up = { type, return: up };
  (el as unknown as Record<string, unknown>)["__reactFiber$x1y2z3"] = { type: el.localName, return: up };
}

describe("pickTarget", () => {
  it("takes a press on a control's glyph or label as the control", () => {
    mount('<div class="composer-card"><button class="composer-send" aria-label="Send"><svg><path d="M1 1"/></svg></button><label class="row"><span>Theme</span></label></div>');
    expect(pickTarget($("path"))).toBe($("button"));
    expect(pickTarget($(".row span"))).toBe($(".row"));
  });

  it("with ⌥ takes exactly what is under the pointer", () => {
    mount('<button class="composer-send"><svg><path d="M1 1"/></svg></button>');
    expect(pickTarget($("path"), true)).toBe($("path"));
  });

  it("takes an icon outside any control as the icon, not a stroke of it", () => {
    mount('<div class="empty"><svg class="mark"><path d="M1 1"/></svg></div>');
    expect(pickTarget($("path"))).toBe($("svg"));
  });

  it("never picks its own chrome, the document, or the box the app renders into", () => {
    // THE MUTANT: drop the chrome check. The hint sits over the window, and pointing near it would
    // pick the picker.
    mount(`<p class="prose">Words</p>`);
    document.body.insertAdjacentHTML("beforeend", `<div class="app-picker-hint" ${APP_PICKER_ATTR}><span>Click a part of Realm</span></div>`);
    expect(pickTarget($(".app-picker-hint span"))).toBeNull();
    expect(pickTarget(document.documentElement)).toBeNull();
    expect(pickTarget(document.body)).toBeNull();
    expect(pickTarget($("#root"))).toBeNull();
    expect(pickTarget($(".prose"))).toBe($(".prose"));
    expect(pickTarget(null)).toBeNull();
  });
});

describe("roleOf", () => {
  it("is the element's own role first, then the one its tag carries", () => {
    mount(`<input type="checkbox" role="switch" class="a"><input type="checkbox" class="b"><input class="c"><textarea></textarea>
      <a href="#x">x</a><a class="bare">y</a><h2>t</h2><select><option>o</option></select><ul><li>i</li></ul><p>p</p>
      <section aria-label="Usage"></section><section class="plain"></section><div class="box"></div>`);
    expect(roleOf($("input.a"))).toBe("switch");
    expect(roleOf($("input.b"))).toBe("checkbox");
    expect(roleOf($("input.c"))).toBe("textbox");
    expect(roleOf($("textarea"))).toBe("textbox");
    expect(roleOf($("a[href]"))).toBe("link");
    expect(roleOf($("a.bare"))).toBe("");
    expect(roleOf($("h2"))).toBe("heading");
    expect(roleOf($("select"))).toBe("combobox");
    expect(roleOf($("li"))).toBe("listitem");
    expect(roleOf($("p"))).toBe("paragraph");
    expect(roleOf($("section[aria-label]"))).toBe("region");
    expect(roleOf($("section.plain"))).toBe("");
    expect(roleOf($("div.box"))).toBe("");
  });
});

describe("accessibleName", () => {
  it("follows accname's order: by reference, aria-label, a field's label, content, title", () => {
    mount(`<span id="lbl">Reduce motion</span><input type="checkbox" role="switch" aria-labelledby="lbl" aria-label="ignored" class="by">
      <button aria-label="Send" title="Send (⌘↵)" class="named"><svg></svg></button>
      <label for="f">Search files</label><input id="f" class="field" placeholder="Type to search">
      <input class="hinted" placeholder="Ask anything"><button class="words"> Open   in a new pane </button>
      <button class="titled" title="More"><svg></svg></button>`);
    expect(accessibleName($(".by"))).toBe("Reduce motion");
    expect(accessibleName($(".named"))).toBe("Send");
    expect(accessibleName($(".field"))).toBe("Search files");
    expect(accessibleName($(".hinted"))).toBe("Ask anything");
    expect(accessibleName($(".words"))).toBe("Open in a new pane");
    expect(accessibleName($(".titled"))).toBe("More");
  });

  it("does not take a container's words as its name — a pane is not called by everything in it", () => {
    mount(`<div class="session-pane"><p>One</p><p>Two</p></div>`);
    expect(accessibleName($(".session-pane"))).toBe("");
  });
});

describe("selectorFor", () => {
  const resolves = (el: Element) => {
    const sel = selectorFor(el);
    expect(document.querySelectorAll(sel), sel).toHaveLength(1);
    expect(document.querySelector(sel), sel).toBe(el);
    return sel;
  };

  it("names the element by Realm's own class names, climbing only as far as it has to", () => {
    mount(`<div class="composer-card"><div class="composer-controls"><button class="icon-btn composer-attach"></button><button class="composer-send"></button></div></div>`);
    expect(resolves($(".composer-send"))).toBe("button.composer-send");
    expect(resolves($(".composer-attach"))).toBe("button.icon-btn.composer-attach");
  });

  it("tells twin siblings apart by their names where they have them, and by position where not", () => {
    mount(`<div class="bar"><button class="icon-btn" aria-label="Back"></button><button class="icon-btn" aria-label="Forward"></button></div>
      <ul class="rows"><li class="item"></li><li class="item"></li><li class="item"></li></ul>`);
    expect(resolves($('[aria-label="Forward"]'))).toBe('button.icon-btn[aria-label="Forward"]');
    expect(resolves($(".rows .item:nth-of-type(2)"))).toBe("li.item:nth-of-type(2)");
  });

  it("never settles for bare tags: a field with no class is named, a classless box is placed by its parent", () => {
    // THE MUTANT: stop at the first unique path. The browser bar's address field is the only `input`
    // on screen, so the agent was handed `input` — unique until the next field opens.
    mount(`<div class="browser-chrome"><input aria-label="Address" role="combobox"></div><div class="panel-body"><span></span></div>`);
    expect(resolves($("input"))).toBe('input[aria-label="Address"]');
    // The only span on screen: unique, and still nothing anyone could look for without its parent.
    expect(resolves($(".panel-body > span"))).toBe("div.panel-body > span");
  });

  it("ends the climb at an id that is a word, and never leans on one a run of the app generated", () => {
    // THE MUTANT: accept every id. `prompt-hint-3f2a…` names one session, so the selector would
    // find nothing the next time anyone looked.
    mount(`<div id="mention-list"><div class="opt"><span class="name"></span></div><div class="opt"></div></div>
      <section class="other"><div class="opt"></div><div class="opt"></div></section>
      <div id="prompt-hint-3f2a9c1b"><span class="composer-hint-text"></span></div><div id="prompt-hint-77ab"><span class="composer-hint-text"></span></div>`);
    expect(resolves($("#mention-list .name"))).toBe("span.name");
    expect(resolves($("#mention-list > .opt:nth-of-type(2)"))).toBe("#mention-list > div.opt:nth-of-type(2)");
    expect(resolves($("#prompt-hint-3f2a9c1b .composer-hint-text"))).not.toContain("prompt-hint");
  });
});

describe("componentChain", () => {
  function Composer() { return null; }
  function SessionPane() { return null; }
  function PaneHost() { return null; }

  it("names the components that drew it, nearest first, unwrapping memo and forwardRef", () => {
    mount('<button class="composer-send"></button>');
    const memoised = { $$typeof: Symbol.for("react.memo"), type: SessionPane };
    const forwarded = { $$typeof: Symbol.for("react.forward_ref"), render: PaneHost };
    // Host fibers (a string type) and fragments (a symbol) between them are skipped.
    fiberOn($("button"), "div", Composer, Symbol.for("react.fragment"), memoised, forwarded);
    expect(componentChain($("button"))).toEqual(["Composer", "SessionPane", "PaneHost"]);
  });

  it("prefers a displayName, names a component once however deep it recurses, and caps the chain", () => {
    mount('<span class="x"></span>');
    const Named = Object.assign(() => null, { displayName: "ItemList" });
    fiberOn($("span"), Named, Named, Composer, SessionPane, PaneHost);
    expect(componentChain($("span"), 2)).toEqual(["ItemList", "Composer"]);
  });

  it("reports nothing a minifier wrote, and nothing at all for a node React did not render", () => {
    mount('<span class="a"></span><span class="b"></span>');
    function Xe() { return null; }
    fiberOn($(".a"), Xe, Composer);
    expect(componentChain($(".a"))).toEqual(["Composer"]);
    expect(componentChain($(".b"))).toEqual([]);
  });

  it("leaves a context's provider out — it is plumbing, not something that drew the element", () => {
    mount('<span class="a"></span>');
    const context = { $$typeof: Symbol.for("react.context"), displayName: "PanelGroupContext" };
    fiberOn($(".a"), Composer, context, SessionPane);
    expect(componentChain($(".a"))).toEqual(["Composer", "SessionPane"]);
  });

  it("never throws on a fiber it does not understand", () => {
    mount('<span class="a"></span>');
    (($(".a") as unknown) as Record<string, unknown>)["__reactFiber$q"] = { get type() { throw new Error("odd"); } };
    expect(componentChain($(".a"))).toEqual([]);
  });
});

describe("hooksOf", () => {
  it("lists the data hooks on the element and up its ancestors, nearest first, with what each is on", () => {
    document.documentElement.setAttribute("data-mode", "dark");
    mount(`<div class="item sb-row" data-active data-actions="1"><button class="item-row" data-pressed data-state="idle"></button></div>`);
    expect(hooksOf($(".item-row"))).toEqual(['data-state="idle" on button.item-row', "data-active on div.item", 'data-actions="1" on div.item']);
    // The window's own state on the root is the whole window's, and a press's bookkeeping is the
    // pointer's — neither says anything about the element.
    document.documentElement.removeAttribute("data-mode");
  });

  it("keeps a hook whose value is an id this run made, but not the id — it names nothing to search for", () => {
    mount(`<div class="panel" data-leaf-id="01M45VJK80BFK48RG28HHN7C4Y" data-panel-size="50.0"><span class="x" data-setting="sidebar-activity-order"></span></div>`);
    expect(hooksOf($(".x"))).toEqual(['data-setting="sidebar-activity-order" on span.x', "data-leaf-id on div.panel", 'data-panel-size="50.0" on div.panel']);
  });
});

describe("describeAppElement", () => {
  it("carries what an agent working on Realm reaches for", () => {
    mount(`<div class="composer-card"><button class="icon-btn composer-send" data-state="send" aria-label="Send"><svg class="send-icon"><path d="M12 5L12 19"/></svg></button></div>`);
    fiberOn($("button"), function Composer() { return null; }, function SessionPane() { return null; });
    const d = describeAppElement($("button"));
    expect(d).toMatchObject({
      selector: "button.icon-btn.composer-send", tag: "button", role: "button", name: "Send",
      app: { components: ["Composer", "SessionPane"], hooks: ['data-state="send" on button.icon-btn'], classes: ["icon-btn", "composer-send"] },
    });
    expect(d.app.window).toEqual({ w: window.innerWidth, h: window.innerHeight });
    // An icon's drawing is numbers nobody reads, and would spend the markup's whole budget.
    expect(d.html).toBe('<button class="icon-btn composer-send" data-state="send" aria-label="Send"><svg class="send-icon"></svg></button>');
  });

  it("clips the markup of a big region to the budget a prompt can carry", () => {
    mount(`<div class="transcript">${"<p>A long answer.</p>".repeat(400)}</div>`);
    const html = markupOf($(".transcript"));
    expect(html).toHaveLength(PICK_HTML_MAX);
    expect(html.endsWith("…")).toBe(true);
  });
});

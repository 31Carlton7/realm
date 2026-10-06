import { describe, expect, it } from "vitest";
import {
  annotationChipLabel, APP_PICK_HOOK_MAX, APP_PICK_HOOKS_MAX, CHIP_LABEL_MAX, chipLabel, ElementChipSchema, elementChipLabel, elementChipToken, elementContext,
  chipRuns, isAppElement, isDeviceElement, keepLiveChips, MAX_ELEMENT_CHIPS, PICK_HTML_MAX, PICK_TEXT_MAX, scanChips, scanElementChips,
  type AppPickedElement, type BrowserPickedElement, type DevicePickedElement,
} from "./index";

const picked = (over: Partial<BrowserPickedElement> = {}): BrowserPickedElement => ({
  ref: 1, url: "https://example.com/login", title: "Sign in",
  rect: { x: 0, y: 0, w: 10, h: 10 },
  selector: "#submit", tag: "button", role: "button", name: "Sign in",
  text: "Sign in", html: '<button id="submit">Sign in</button>', ...over,
});

describe("scanElementChips", () => {
  it("bounds the whole token, sigil and brackets included", () => {
    expect(scanElementChips('go @[button "Sign in"] now')).toEqual([
      { kind: "element", label: 'button "Sign in"', start: 3, end: 22 },
    ]);
  });

  it("never lets an unclosed token swallow the next one", () => {
    expect(scanElementChips("@[a and @[b]")).toEqual([{ kind: "element", label: "b", start: 8, end: 12 }]);
  });

  it("does not span a line — a chip the caret could sit inside is not one run", () => {
    expect(scanElementChips("@[a\nb]")).toEqual([]);
  });

  it("finds every chip in text order", () => {
    expect(scanElementChips("@[a] and @[b]").map((c) => c.label)).toEqual(["a", "b"]);
  });
});

describe("scanChips", () => {
  it("returns mentions and elements together, in text order", () => {
    expect(scanChips("@mac then @[button] then @web", ["mac", "web"]).map((c) => `${c.kind}:${c.label}`))
      .toEqual(["mention:mac", "element:button", "mention:web"]);
  });

  it("a mention INSIDE an element chip is not a mention — the runs would overlap and print twice", () => {
    // A hand-typed or pasted token can hold anything; only the picker's own labels are sanitised.
    expect(scanChips('look at @[button "hi @mac"] please', ["mac"]).map((c) => c.kind)).toEqual(["element"]);
  });

  it("an element token is invisible to the mention scan, so the two can never overlap", () => {
    // `[` is not an id character, so the mention candidate after `@` is empty — this is the property
    // that lets both grammars share the `@` sigil without a precedence rule.
    expect(scanChips("@[button]", ["button"]).map((c) => c.kind)).toEqual(["element"]);
  });

});

describe("chipLabel", () => {
  it("removes the characters that would end the token early", () => {
    expect(chipLabel("a ] b [ c")).toBe("a b c");
    expect(chipLabel("two\nlines")).toBe("two lines");
  });

  it("removes the `@` a page could put in an element's name to smuggle a skill mention into a draft", () => {
    expect(chipLabel("hi @mac")).toBe("hi mac");
  });

  it("clips to a length a one-line draft can still show whole", () => {
    const long = chipLabel("x".repeat(200));
    expect(long).toHaveLength(CHIP_LABEL_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("elementChipLabel", () => {
  it("names the element by what it MEANS — its AX role and accessible name", () => {
    expect(elementChipLabel(picked())).toBe('button "Sign in"');
  });

  it("falls back to the selector's last segment for the nameless containers most of a page is", () => {
    expect(elementChipLabel(picked({ role: "", name: "", text: "", tag: "div", selector: "main > div#hero" }))).toBe("div#hero");
  });

  it("disambiguates a name so long the label was already clipped — the case that used to never return", () => {
    const long = picked({ name: "x".repeat(110) });
    const first = elementChipLabel(long);
    expect(first).toHaveLength(CHIP_LABEL_MAX);
    const second = elementChipLabel(long, [first]);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(CHIP_LABEL_MAX);
    // …and it keeps going for as many chips as one message may carry.
    const labels: string[] = [];
    for (let i = 0; i < MAX_ELEMENT_CHIPS; i++) labels.push(elementChipLabel(long, labels));
    expect(new Set(labels).size).toBe(MAX_ELEMENT_CHIPS);
  });

  it("disambiguates against labels already in the draft, so two identical buttons stay two chips", () => {
    const first = elementChipLabel(picked());
    expect(elementChipLabel(picked(), [first])).toBe('button "Sign in" 2');
    expect(elementChipLabel(picked(), [first, 'button "Sign in" 2'])).toBe('button "Sign in" 3');
  });
});

describe("elementContext", () => {
  it("is EMPTY with no chips — a message that never touched a browser pane goes out byte for byte", () => {
    expect(elementContext([])).toBe("");
  });

  it("fences the page's account of itself, and states only the origin outside", () => {
    const out = elementContext([{ label: 'button "Sign in"', element: picked() }]);
    const fence = out.match(/untrusted-[0-9a-f]{16}/)![0];
    const inside = out.slice(out.indexOf(`<<<${fence}`), out.indexOf(`${fence}>>>`));
    expect(inside).toContain('html: <button id="submit">Sign in</button>');
    expect(inside).toContain("selector: #submit");
    // The path is page-authored (`history.pushState` moves it), so the full url goes UNDER the fence;
    // only the origin, which script cannot move the webContents off, is stated outside it.
    expect(inside).toContain("url: https://example.com/login");
    expect(out).toContain('  @[button "Sign in"] — https://example.com');
    expect(out.slice(0, out.indexOf("Everything between"))).not.toContain("/login");
  });

  it("describes a DEVICE element by what it has, and never by a selector it does not", () => {
    const el = picked({
      selector: "", html: "", tag: "canvas", role: "button", name: "General", text: "",
      url: "http://127.0.0.1:3200/", title: "Simulator - iPhone 17 Pro",
      device: { id: "com.apple.settings.general", path: "0.1.1", enabled: true,
        frame: { x: 16, y: 293.3333333333333, width: 370, height: 44 }, screen: { width: 402, height: 874 } },
    });
    const out = elementContext([{ label: 'button "General"', element: el }]);
    expect(out).toContain("id: com.apple.settings.general");
    expect(out).toContain("path: 0.1.1");
    // Rounded: a prompt is read by a person and a model, and neither is helped by 293.3333333333333.
    expect(out).toContain("frame: x=16 y=293.3 w=370 h=44 in a 402×874 point screen");
    // THE MUTANT: keep printing the DOM lines for a device element. `selector: (none found)` reads as
    // "we looked and there was none", which is a different claim from "this is not in the document".
    expect(out).not.toContain("selector:");
    expect(out).not.toContain("tag:");
  });

  it("warns, in Realm's own voice, that a device element cannot be acted on through the browser", () => {
    const el = picked({ device: { id: "a", path: "0", enabled: true, frame: { x: 0, y: 0, width: 1, height: 1 }, screen: { width: 10, height: 10 } } });
    const out = elementContext([{ label: "x", element: el }]);
    // OUTSIDE the fence: it is a fact about Realm's tools, not something the page or device said.
    // THE MUTANT: drop it, and an agent tries browser_act on a chip whose ref is the video surface —
    // clicking the middle of the screen and reporting success.
    expect(out.slice(0, out.indexOf("Everything between"))).toContain("browser_act cannot address it");
    // And an ordinary web pick is left exactly as it was: no note, no new bytes.
    expect(elementContext([{ label: "x", element: picked() }])).not.toContain("browser_act cannot address it");
  });

  it("gives each chip a fresh fence token, so page markup cannot close one it has seen before", () => {
    const a = elementContext([{ label: "x", element: picked() }]).match(/untrusted-[0-9a-f]{16}/)![0];
    const b = elementContext([{ label: "x", element: picked() }]).match(/untrusted-[0-9a-f]{16}/)![0];
    expect(a).not.toBe(b);
  });
});

describe("keepLiveChips", () => {
  it("forgets an element whose chip the user deleted, and keeps the one still there", () => {
    const kept = { label: "a", element: picked() };
    const gone = { label: "b", element: picked() };
    expect(keepLiveChips(`hello ${elementChipToken("a")}`, [kept, gone])).toEqual([kept]);
  });

});

describe("ElementChipSchema", () => {

  it("refuses markup longer than the picker clips to — such a chip did not come from the picker", () => {
    expect(ElementChipSchema.safeParse({ label: "x", element: picked({ html: "y".repeat(PICK_HTML_MAX + 1) }) }).success).toBe(false);
  });

  it("refuses a label longer than a chip can show, so the composer and the wire agree on one", () => {
    expect(ElementChipSchema.safeParse({ label: "x".repeat(CHIP_LABEL_MAX + 1), element: picked() }).success).toBe(false);
  });
});

describe("chipRuns", () => {
  const rejoin = (text: string, ids: string[]) => chipRuns(text, ids).map((r) => r.text).join("");

  it("partitions the text — every rendering of chips still shows exactly what was typed", () => {
    for (const text of [
      "", "@mac", "@mac go", "go @mac", "a @mac b @[button] c", "@[button]", "@", "@[", "@[]",
      "carlton@mac", "@nonesuch", "line\n@mac\nline", "@mac@mac", "@[a @mac b]", "x @[@mac] y",
    ]) expect(rejoin(text, ["mac"])).toBe(text);
  });

  it("marks the chips and leaves everything else plain", () => {
    expect(chipRuns('use @mac on @[button "Go"] now', ["mac"]).map((r) => [r.chip?.kind ?? "text", r.text])).toEqual([
      ["text", "use "], ["mention", "@mac"], ["text", " on "], ["element", '@[button "Go"]'], ["text", " now"],
    ]);
  });

});

/**
 * Plan 26 W7d — an ANNOTATION: several elements pinned on one page and sent as one chip. One token
 * stands for every sidecar entry under its label; `pin` is the number the user saw on the page.
 */
describe("annotation chips", () => {
  const pins = (label = "3 annotations", shot?: string) => [1, 2, 3].map((n) => ({
    label, element: picked({ ref: 40 + n, name: `Item ${n}`, selector: `#item-${n}` }), pin: n, ...(shot ? { shot } : {}),
  }));

  it("count the pins as a person would, and never collide with a chip already in the draft", () => {
    expect(annotationChipLabel(1)).toBe("1 annotation");
    expect(annotationChipLabel(3)).toBe("3 annotations");
    expect(annotationChipLabel(3, ["3 annotations"])).toBe("3 annotations 2");
  });

  it("one token keeps every pin it stands for, and deleting it forgets them all", () => {
    const chips = pins();
    expect(keepLiveChips(`look at ${elementChipToken("3 annotations")} please`, chips)).toEqual(chips);
    expect(keepLiveChips("look at these please", chips)).toEqual([]);
  });

  it("the agent is told each pin by its number, and the token is listed once, not once per pin", () => {
    const out = elementContext(pins("3 annotations", "127.0.0.1-8971-2026-10-01T19-30-05-annotations.png"));
    const fence = out.match(/untrusted-[0-9a-f]{16}/)![0];
    const outside = out.slice(0, out.indexOf(`<<<${fence}`));
    const inside = out.slice(out.indexOf(`<<<${fence}`), out.indexOf(`${fence}>>>`));
    // THE mutant: one index line per entry. Three lines of the same token read as three chips.
    expect(outside.split("\n").filter((l) => l.includes("@[3 annotations]"))).toEqual(["  @[3 annotations] — https://example.com, 3 pins"]);
    for (const n of [1, 2, 3]) expect(inside).toContain(`@[3 annotations] pin ${n}\nurl: https://example.com/login\nselector: #item-${n}`);
    // Realm's own voice, outside the fence: what the numbers are, and which attachment shows them.
    expect(outside).toContain("numbered in the order they pinned them; the attached 127.0.0.1-8971-2026-10-01T19-30-05-annotations.png shows each number");
  });

  it("an ordinary pick goes out exactly as it did before annotations existed", () => {
    const out = elementContext([{ label: 'button "Sign in"', element: picked() }]);
    expect(out).not.toContain("annotation");
    expect(out).not.toContain(" pin ");
    expect(out).toContain('  @[button "Sign in"] — https://example.com\n');
  });

  it("the wire carries a pin and its screenshot, and still takes a chip from before either existed", () => {
    expect(ElementChipSchema.parse({ label: "3 annotations", element: picked(), pin: 2, shot: "a.png" })).toMatchObject({ pin: 2, shot: "a.png" });
    expect(ElementChipSchema.safeParse({ label: "x", element: picked() }).success).toBe(true);
    expect(ElementChipSchema.safeParse({ label: "x", element: picked(), pin: 0 }).success).toBe(false);
    expect(ElementChipSchema.safeParse({ label: "x", element: picked(), pin: MAX_ELEMENT_CHIPS + 1 }).success).toBe(false);
  });
});

/**
 * A part of Realm's OWN window (the renderer's app-pick/): the same chip as a page element, a
 * description written for an agent working on Realm, and a picture named only while it is on the message.
 */
describe("app chips", () => {
  const SHOT = "/realm/tmp/attachments/a1b2c3-realm-send-button.png";
  const appPicked = (over: Partial<Omit<AppPickedElement, "app">> = {}, app: Partial<AppPickedElement["app"]> = {}): AppPickedElement => ({
    rect: { x: 1120.4, y: 838.25, w: 32, h: 32 },
    selector: ".composer-card > button.composer-send",
    tag: "button", role: "button", name: "Send", text: "",
    html: '<button class="composer-send" aria-label="Send"><svg></svg></button>',
    ...over,
    app: {
      components: ["Composer", "SessionPane", "PaneHost"], hooks: ['data-state="send" on button.composer-send'],
      classes: ["composer-send"], window: { w: 1400, h: 900 }, shot: SHOT, webView: false, ...app,
    },
  });

  it("is named the way a person points at it — its name and what its role is called — under Realm's name", () => {
    expect(elementChipLabel(appPicked())).toBe("Realm · Send button");
    expect(elementChipLabel(appPicked({ role: "switch", name: "Reduce motion", tag: "input" }))).toBe("Realm · Reduce motion switch");
    expect(elementChipLabel(appPicked({ role: "textbox", name: "Message", tag: "textarea" }))).toBe("Realm · Message field");
    // A name that already says what it is is not said twice.
    expect(elementChipLabel(appPicked({ name: "Close button" }))).toBe("Realm · Close button");
    // A combobox is a field with suggestions as an input, and a pop-up menu as a select.
    expect(elementChipLabel(appPicked({ role: "combobox", name: "Address", tag: "input" }))).toBe("Realm · Address field");
    expect(elementChipLabel(appPicked({ role: "combobox", name: "Theme", tag: "select" }))).toBe("Realm · Theme menu");
  });

  it("names a nameless box by the component that drew it, then by its selector's last step", () => {
    expect(elementChipLabel(appPicked({ role: "", name: "", tag: "div" }))).toBe("Realm · Composer");
    expect(elementChipLabel(appPicked({ role: "", name: "", tag: "div", selector: "main > div.composer-card" }, { components: [] }))).toBe("Realm · div.composer-card");
  });

  it("lets a short run of text be its own name, and never a paragraph's opening words", () => {
    expect(elementChipLabel(appPicked({ role: "", name: "", tag: "span", text: "Pricing page" }))).toBe("Realm · Pricing page");
    const prose = "I'll put the launch plan in a note, and sketch the greeting as a script.";
    expect(elementChipLabel(appPicked({ role: "paragraph", name: "", tag: "p", text: prose }))).toBe("Realm · Composer");
  });

  it("says in the chip when there is no picture, where the person reads it before sending", () => {
    // THE MUTANT: leave the label alone. The description says so too, but nobody reads that before send.
    expect(elementChipLabel(appPicked({}, { shot: null, webView: true }))).toBe("Realm · Send button (no picture)");
    // The note survives a name long enough to clip: the name gives way, never the note.
    const long = elementChipLabel(appPicked({ name: "x".repeat(110) }, { shot: null }));
    expect(long).toHaveLength(CHIP_LABEL_MAX);
    expect(long.startsWith("Realm · x")).toBe(true);
    expect(long.endsWith("… (no picture)")).toBe(true);
  });

  it("rides the same wire as a page element, and the two come back apart", () => {
    const app = ElementChipSchema.parse({ label: "Realm · Send button", element: appPicked() });
    expect(isAppElement(app.element)).toBe(true);
    expect(app.element).toEqual(appPicked());
    const page = ElementChipSchema.parse({ label: 'button "Sign in"', element: picked() });
    expect(isAppElement(page.element)).toBe(false);
    // …and is held to bounds of its own: a chip that exceeds them did not come from the picker.
    expect(ElementChipSchema.safeParse({ label: "x", element: appPicked({}, { hooks: Array(APP_PICK_HOOKS_MAX + 1).fill("data-a") }) }).success).toBe(false);
    expect(ElementChipSchema.safeParse({ label: "x", element: appPicked({}, { hooks: ["d".repeat(APP_PICK_HOOK_MAX + 1)] }) }).success).toBe(false);
    expect(ElementChipSchema.safeParse({ label: "x", element: appPicked({ html: "y".repeat(PICK_HTML_MAX + 1) }) }).success).toBe(false);
  });

  it("describes itself plainly, for an agent working on Realm — component, selector, hooks and box", () => {
    const out = elementContext([{ label: "Realm · Send button", element: appPicked() }], [{ path: SHOT }]);
    expect(out).toContain("Parts of Realm's own window the user picked, one per chip above:\n  @[Realm · Send button] — the attached a1b2c3-realm-send-button.png shows it");
    expect(out).toContain("the browser tools cannot reach them");
    expect(out).toContain("component: Composer, inside SessionPane › PaneHost");
    expect(out).toContain("role: button\nname: Send\nselector: .composer-card > button.composer-send\nclasses: composer-send");
    expect(out).toContain('data hooks: data-state="send" on button.composer-send');
    expect(out).toContain("box: x=1120.4 y=838.3 w=32 h=32 in a 1400×900 window");
    // Not fenced, for realm-app's snapshot's reason: it is Realm's own interface, not a third party's.
    expect(out).not.toMatch(/untrusted-[0-9a-f]{16}/);
  });

  it("names the picture only while the message still carries it", () => {
    // THE MUTANT: trust `shot` alone. The person took the tile off, and the agent is told to look at
    // a file it was never given.
    const taken = elementContext([{ label: "Realm · Send button", element: appPicked() }], []);
    expect(taken).toContain("  @[Realm · Send button] — no picture");
    expect(taken).not.toContain("a1b2c3-realm-send-button.png");
    const view = elementContext([{ label: "Realm · Browser pane (no picture)", element: appPicked({ name: "" }, { shot: null, webView: true }) }], [{ path: SHOT }]);
    expect(view).toContain("no picture: it covers a browser pane's page, which a capture of Realm's window cannot see");
  });

  it("puts a page's elements first and Realm's after, each under its own head, and leaves page-only messages alone", () => {
    const both = elementContext([
      { label: "Realm · Send button", element: appPicked() },
      { label: 'button "Sign in"', element: picked() },
    ], [{ path: SHOT }]);
    const page = both.indexOf("Elements the user picked in Realm's browser pane");
    const app = both.indexOf("Parts of Realm's own window the user picked");
    expect(page).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThan(page);
    // The page block lists only the page's chip.
    expect(both.slice(page, app)).not.toContain("Realm · Send button");
    expect(elementContext([{ label: 'button "Sign in"', element: picked() }])).not.toContain("Realm's own window");
  });
});

describe("device chips", () => {
  const SHOT = "/realm/tmp/attachments/f00d-iphone-general-button.png";
  const SIM = "01JD2ZQ5Y3W8ZGZ1X6M2R7S9TA";
  const devicePicked = (over: Partial<Omit<DevicePickedElement, "simulator">> = {}, simulator: Partial<DevicePickedElement["simulator"]> = {}): DevicePickedElement => ({
    role: "Button", label: "General", value: "", id: "com.apple.settings.general", enabled: true,
    frame: { x: 16, y: 293.33333333333337, width: 370, height: 44 }, screen: { width: 402, height: 874 }, units: "points",
    ...over,
    simulator: { id: SIM, kind: "iPhone", platform: "ios", physical: false, app: "Settings", shot: SHOT, ...simulator },
  });

  it("is named by what the device is, then by its label and what its type is called", () => {
    expect(elementChipLabel(devicePicked())).toBe("iPhone · General button");
    expect(elementChipLabel(devicePicked({ role: "Switch", label: "Wi-Fi", value: "1" }))).toBe("iPhone · Wi-Fi switch");
    // Android passes its widget classes through, so the class's last word is what is looked up.
    expect(elementChipLabel(devicePicked({ role: "android.widget.EditText", label: "Search" }, { kind: "Android", platform: "android" }))).toBe("Android · Search field");
    // A type nobody says aloud leaves the element to its label; a nameless one goes by its value, its id, then its type.
    expect(elementChipLabel(devicePicked({ role: "Cell", label: "Lemon pasta" }))).toBe("iPhone · Lemon pasta");
    expect(elementChipLabel(devicePicked({ role: "TextField", label: "", value: "carlton" }))).toBe("iPhone · carlton field");
    expect(elementChipLabel(devicePicked({ role: "Other", label: "", value: "", id: null }))).toBe("iPhone · Other");
  });

  it("says in the chip when there is no picture, and keeps the note when the name is clipped", () => {
    expect(elementChipLabel(devicePicked({}, { shot: null }))).toBe("iPhone · General button (no picture)");
    const long = elementChipLabel(devicePicked({ label: "x".repeat(200) }, { shot: null }));
    expect(long).toHaveLength(CHIP_LABEL_MAX);
    expect(long.endsWith("… (no picture)")).toBe(true);
    // An app's label may carry the characters that would end the token or smuggle a mention in.
    expect(elementChipLabel(devicePicked({ label: "hi @mac [x]" }))).toBe("iPhone · hi mac x button");
  });

  it("rides the same wire as the other two, and comes back as itself", () => {
    // THE MUTANT: no device shape on the wire. Every chip the simulator pane made would bounce at send.
    const device = ElementChipSchema.parse({ label: "iPhone · General button", element: devicePicked() });
    expect(isDeviceElement(device.element)).toBe(true);
    expect(isAppElement(device.element)).toBe(false);
    expect(device.element).toEqual(devicePicked());
    expect(isDeviceElement(ElementChipSchema.parse({ label: 'button "Sign in"', element: picked() }).element)).toBe(false);
    // Held to bounds of its own, and to a real simulator id.
    expect(ElementChipSchema.safeParse({ label: "x", element: devicePicked({ label: "y".repeat(PICK_TEXT_MAX + 1) }) }).success).toBe(false);
    expect(ElementChipSchema.safeParse({ label: "x", element: devicePicked({}, { id: "not-an-id" }) }).success).toBe(false);
  });

  it("tells the agent which device, how to act on it, and fences what the app said", () => {
    const out = elementContext([{ label: "iPhone · General button", element: devicePicked() }], [{ path: SHOT }]);
    expect(out).toContain("Elements the user picked on a device's screen in Realm's simulator pane, one per chip above:\n"
      + `  @[iPhone · General button] — an iOS simulator, simulatorId ${SIM}; the attached f00d-iphone-general-button.png shows it`);
    expect(out).toContain("the browser tools cannot reach them");
    expect(out).toContain("simulator_elements numbers what is on the screen now, and simulator_tap takes that number");
    const fenced = out.slice(out.search(/untrusted-[0-9a-f]{16}/));
    expect(fenced).toContain("app in front: Settings\nrole: Button\nlabel: General\nid: com.apple.settings.general\nenabled: true");
    expect(fenced).toContain("frame: x=16 y=293.3 w=370 h=44 in a 402×874 point screen");
    // THE MUTANT: the app's own words outside the fence. A label is the app's to write, so is its name.
    expect(out.slice(0, out.search(/untrusted-[0-9a-f]{16}/))).not.toContain("Settings");
  });

  it("names the picture only while the message carries it, and says what kind of device it is", () => {
    const taken = elementContext([{ label: "iPhone · General button", element: devicePicked() }], []);
    expect(taken).toContain(`— an iOS simulator, simulatorId ${SIM}; no picture`);
    expect(elementContext([{ label: "x", element: devicePicked({}, { physical: true }) }])).toContain("— a real iOS device");
    expect(elementContext([{ label: "x", element: devicePicked({ units: "pixels" }, { platform: "android", kind: "Android" }) }]))
      .toContain("— an Android emulator");
    expect(elementContext([{ label: "x", element: devicePicked({ units: "pixels" }, { platform: "android" }) }])).toContain("in a 402×874 pixel screen");
  });

  it("comes after a page's elements and Realm's, under its own head, and leaves the other two alone", () => {
    const all = elementContext([
      { label: "iPhone · General button", element: devicePicked() },
      { label: 'button "Sign in"', element: picked() },
    ]);
    const page = all.indexOf("Elements the user picked in Realm's browser pane");
    const device = all.indexOf("on a device's screen in Realm's simulator pane");
    expect(page).toBeGreaterThanOrEqual(0);
    expect(device).toBeGreaterThan(page);
    // THE MUTANT: a device chip read as a page's. It would be listed with a URL it does not have.
    expect(all.slice(page, device)).not.toContain("iPhone · General button");
    expect(elementContext([{ label: 'button "Sign in"', element: picked() }])).not.toContain("simulator pane");
  });
});

import { describe, expect, it, vi } from "vitest";
import { FAVICON_MAX_BYTES, isFaviconDataUrl, type BrowserLoadError } from "@realm/contracts";
import {
  ACTIVATION_MS, AGENT_GRACE_MS, PARKED_OPENERS, TABS_PER_PRESS, BrowserPaneHost, UNCLAIMED_TAB_MS, UserActivation, hostedTab, sendAsAgent, type TabAnswer, DEVICE_PRESETS, PageLoad, FAVICON_TRIES, HIDDEN_KEEP_MAX_MS, HiddenViews, POPUP_LIMIT, RETAINED_VIEW_LIMIT, ZOOM_FACTORS, browserUserAgent, createFaviconResolver, dataUrlBytes, deviceFit, faviconDataUrl, retainedBudget,
  isFindShortcut, nextZoomFactor, normalizeAddress, originAllowed, popupBounds, popupTitle, rankFavicons, readCapped, shownPage, sniffImage, toViewBounds, windowOpenAction, zoomPercent,
  type DeviceMetrics,
  type BrowserViewState, type FindResult, type ViewHandle, type KeepReason, type ViewHooks, type WindowKeyboard,
} from "./browser-host";

describe("normalizeAddress", () => {
  it("keeps http(s) URLs and about:blank as-is", () => {
    expect(normalizeAddress("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(normalizeAddress("http://example.com")).toBe("http://example.com");
    expect(normalizeAddress("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
    expect(normalizeAddress("about:blank")).toBe("about:blank");
  });
  it("prefixes https:// onto host-shaped input", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeAddress("example.com:8443/x")).toBe("https://example.com:8443/x");
    expect(normalizeAddress("sub.example.co.uk")).toBe("https://sub.example.co.uk");
    expect(normalizeAddress("192.168.1.5:8080")).toBe("https://192.168.1.5:8080");
    expect(normalizeAddress("münchen.de")).toBe("https://münchen.de");
  });
  it("sends anything that is not host-shaped to the search engine", () => {
    expect(normalizeAddress("not a url")).toBe("https://www.google.com/search?q=not%20a%20url");
    expect(normalizeAddress("realm")).toBe("https://www.google.com/search?q=realm");
    expect(normalizeAddress("3.14")).toBe("https://www.google.com/search?q=3.14");
    expect(normalizeAddress("what is a WebContentsView?")).toBe(
      "https://www.google.com/search?q=what%20is%20a%20WebContentsView%3F",
    );
    // A scheme-shaped input is NOT honored: file:/javascript: never reach loadURL as themselves,
    // and no longer get https:// glued on to fail — they are searched like any other words.
    expect(normalizeAddress("javascript:alert(1)")).toBe("https://www.google.com/search?q=javascript%3Aalert(1)");
    expect(normalizeAddress("file:///etc/passwd")).toBe("https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd");
  });
  it("loopback hosts get http:// (dev servers do not speak TLS)", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("localhost")).toBe("http://localhost");
    expect(normalizeAddress("127.0.0.1:8787/health")).toBe("http://127.0.0.1:8787/health");
    expect(normalizeAddress("[::1]:3000")).toBe("http://[::1]:3000");
    // ...but a host merely containing "localhost" does not.
    expect(normalizeAddress("localhost.evil.com")).toBe("https://localhost.evil.com");
    // A bare non-loopback word is a search, not an intranet guess.
    expect(normalizeAddress("myserver")).toBe("https://www.google.com/search?q=myserver");
  });
  it("empty and whitespace-only input is nothing to load", () => {
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress(" example.com ")).toBe("https://example.com");
  });
});

describe("originAllowed", () => {
  it("null list = allow everything (W1 default posture)", () => {
    expect(originAllowed("https://anything.example", null)).toBe(true);
    expect(originAllowed("data:text/html,hi", null)).toBe(true);
  });
  it("a present list allows exactly its origins", () => {
    const list = ["https://example.com", "docs.example.org"];
    expect(originAllowed("https://example.com/deep/path", list)).toBe(true);
    expect(originAllowed("https://docs.example.org", list)).toBe(true); // bare entry = https origin
    expect(originAllowed("https://evil.com", list)).toBe(false);
    expect(originAllowed("https://sub.example.com", list)).toBe(false); // exact origin, no subdomain grant
    expect(originAllowed("http://example.com", list)).toBe(false); // scheme is part of the origin
    expect(originAllowed("https://example.com:8443", list)).toBe(false); // port too
  });
  it("about:blank is always allowed; opaque and unparseable URLs never match a list", () => {
    expect(originAllowed("about:blank", [])).toBe(true);
    expect(originAllowed("data:text/html,hi", ["https://example.com"])).toBe(false);
    expect(originAllowed("not a url", ["https://example.com"])).toBe(false);
  });
  it("junk entries are skipped, not crashed on", () => {
    expect(originAllowed("https://example.com", ["", "   ", "%%%", "https://example.com"])).toBe(true);
    expect(originAllowed("https://example.com", ["%%%"])).toBe(false);
  });
});

describe("windowOpenAction", () => {
  /* The owner's bug: "Sign in with Google" opened the provider's page IN the pane, replacing the page
     waiting for its answer, so the account pick posted to no opener and stopped on a blank screen. */
  it("a window.open with features is a popup — the sign-in shape every SDK uses", () => {
    // Chromium reports `window.open(url, "auth", "width=500,height=600")` as a new window. The mutant
    // that drops that clause sends every sign-in back into the pane.
    expect(windowOpenAction({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x", disposition: "new-window" }, 0)).toBe("popup");
  });

  it("a link meant for a new tab is a new tab: in front for a click, behind for a ⌘- or middle-click", () => {
    // The owner's bug (#537): target=_blank, window.open(url), noopener and a form's target=_blank all
    // replaced the page that was clicked on. THE MUTANT: answer "in-place" for either tab.
    expect(windowOpenAction({ url: "https://example.com/docs", disposition: "foreground-tab" }, 0)).toBe("foreground-tab");
    expect(windowOpenAction({ url: "https://example.com/docs", disposition: "background-tab" }, 0)).toBe("background-tab");
  });

  it("anything else that is not a window stays in place", () => {
    expect(windowOpenAction({ url: "https://example.com/docs", disposition: "default" }, 0)).toBe("in-place");
    expect(windowOpenAction({ url: "https://example.com/docs", disposition: "current-tab" }, 0)).toBe("in-place");
    expect(windowOpenAction({ url: "https://example.com/docs", disposition: "other" }, 0)).toBe("in-place");
  });

  it("an empty window is a popup whatever its disposition: the page means to script it, and the pane must not go blank", () => {
    // `window.open()` arrives as a foreground tab on about:blank. In place, it navigated the pane to a
    // blank page — the mutant that drops the clause brings that back.
    expect(windowOpenAction({ url: "about:blank", disposition: "foreground-tab" }, 0)).toBe("popup");
    expect(windowOpenAction({ url: "", disposition: "foreground-tab" }, 0)).toBe("popup");
  });

  it("refuses a popup past the limit — Electron has no popup blocker — and still lets links through", () => {
    const signIn = { url: "https://accounts.google.com/", disposition: "new-window" };
    expect(windowOpenAction(signIn, POPUP_LIMIT - 1)).toBe("popup");
    expect(windowOpenAction(signIn, POPUP_LIMIT)).toBe("refuse"); // the `<=` mutant opens one more
    expect(windowOpenAction({ url: "about:blank", disposition: "foreground-tab" }, POPUP_LIMIT)).toBe("refuse");
    expect(windowOpenAction({ url: "https://example.com/", disposition: "foreground-tab" }, POPUP_LIMIT)).toBe("foreground-tab");
  });
});

describe("UserActivation", () => {
  it("lets one press open TABS_PER_PRESS tabs, so a click that opens two windows opens two tabs, and refuses the rest", () => {
    // THE MUTANTS: spend the press on the first tab, and the second window of one click goes in place,
    // taking the clicked page with it; never count, and a page looping window.open fills the strip.
    const a = new UserActivation();
    a.note("mouseDown", 1_000);
    for (let i = 0; i < TABS_PER_PRESS; i++) expect(a.decide(1_001, false)).toBe("tab");
    expect(a.decide(1_002, false)).toBe("refuse");
    expect(TABS_PER_PRESS).toBe(3);
  });

  it("counts again from a new press", () => {
    // THE MUTANT: keep the count across presses, and a page someone has clicked on three times opens no more tabs.
    const a = new UserActivation();
    a.note("mouseDown", 0);
    for (let i = 0; i < TABS_PER_PRESS; i++) a.decide(1, false);
    a.note("keyDown", 2);
    expect(a.decide(3, false)).toBe("tab");
  });

  it("counts the windows Chromium marked as gestured toward the same press", () => {
    // THE MUTANT: let a gestured window through uncounted, and each window of a looping click handler
    // that Chromium happens to mark gets a tab on top of the cap.
    const a = new UserActivation();
    a.note("mouseDown", 0);
    for (let i = 0; i < TABS_PER_PRESS; i++) expect(a.decide(1, true)).toBe("tab");
    expect(a.decide(1, true)).toBe("refuse");
  });

  it("takes a gestured window with no main-frame press behind it for a press of its own: a click in a cross-site frame", () => {
    // THE MUTANT: treat it as no press, and a link in a cross-site frame goes in place instead of opening a tab.
    const a = new UserActivation();
    expect(a.decide(1_000, true)).toBe("tab");
    expect(a.decide(1_001, false)).toBe("tab");
  });

  it("goes in place when nothing was pressed and Chromium saw no gesture", () => {
    const a = new UserActivation();
    expect(a.decide(1_000, false)).toBe("in-place");
  });

  it("runs out", () => {
    // THE MUTANT: no expiry, and a click an hour ago still opens the tab a timer asks for now.
    const a = new UserActivation();
    a.note("mouseDown", 1_000);
    expect(a.decide(1_000 + ACTIVATION_MS, false)).toBe("in-place");
  });

  it("lasts five seconds, as Chromium's does", () => {
    // THE MUTANT: any other ACTIVATION_MS — the tests above read the constant, so only a number here pins it.
    const pressed = new UserActivation();
    pressed.note("mouseDown", 0);
    expect(pressed.decide(4_999, false)).toBe("tab");
    const lapsed = new UserActivation();
    lapsed.note("mouseDown", 0);
    expect(lapsed.decide(5_000, false)).toBe("in-place");
  });

  it("belongs to the page pressed on: a navigation forgets the press and its count", () => {
    // THE MUTANTS: keep the press across documents, and a link clicked to a page that calls window.open
    // as it loads opens that page's tab as if the click had been for it; keep the count, and a
    // gestured click on the next page is refused.
    const a = new UserActivation();
    a.note("mouseDown", 0);
    a.forget();
    expect(a.decide(1, false)).toBe("in-place");
    const spent = new UserActivation();
    spent.note("mouseDown", 0);
    for (let i = 0; i < TABS_PER_PRESS; i++) spent.decide(1, false);
    spent.forget();
    expect(spent.decide(2, true)).toBe("tab");
  });

  it("tells the agent's press from the person's, so the agent's tab never takes the keyboard (#561)", async () => {
    // THE MUTANTS: never mark the agent's press, and its click in a page holding the keyboard moves the
    // keyboard into its tab; mark only the press and not the command in flight, and a window opened by
    // a click in a cross-site frame, which no main-frame press shows, is the person's.
    const a = new UserActivation();
    await a.asAgent(async () => {
      a.note("mouseDown", 1_000);
      expect(a.personPressed(1_000)).toBe(false);
    });
    expect(a.decide(1_001, true)).toBe("tab");
    expect(a.personPressed(1_001)).toBe(false);
    const frame = new UserActivation();
    await frame.asAgent(async () => {
      // Main asks before it decides: the keyboard is read off the opener ahead of the page being made.
      expect(frame.personPressed(1_000)).toBe(false);
      expect(frame.decide(1_000, true)).toBe("tab");
    });
    expect(frame.personPressed(1_001)).toBe(false);
  });

  it("gives the keyboard back to the person's press once theirs is the last", async () => {
    // THE MUTANTS: keep the agent's mark past the next press, and the person's click after the agent's
    // opens a tab that leaves the keyboard behind (#547); keep it past ACTIVATION_MS, and the same for a
    // timer's window after it.
    const a = new UserActivation();
    await a.asAgent(async () => { a.note("mouseDown", 0); });
    a.note("mouseDown", 10);
    expect(a.personPressed(11)).toBe(true);
    const lapsed = new UserActivation();
    await lapsed.asAgent(async () => { lapsed.note("mouseDown", 0); });
    expect(lapsed.personPressed(ACTIVATION_MS - 1)).toBe(false);
    expect(lapsed.personPressed(ACTIVATION_MS)).toBe(true);
    const person = new UserActivation();
    person.note("mouseDown", 0);
    expect(person.personPressed(1)).toBe(true);
  });

  it("ends the agent's command when it fails, so the person's next press is theirs", async () => {
    // THE MUTANT: count down only on success, and one failed CDP click marks every press after it as the agent's.
    const a = new UserActivation();
    await expect(a.asAgent(async () => { throw new Error("detached"); })).rejects.toThrow("detached");
    a.note("mouseDown", 0);
    expect(a.personPressed(1)).toBe(true);
  });

  it("leaves the person's click in a cross-site frame theirs", () => {
    // THE MUTANT: mark a gestured window's press as the agent's with no command in flight, and the
    // person's click on a link in a cross-site frame opens a tab that leaves the keyboard behind.
    const a = new UserActivation();
    expect(a.decide(1_000, true)).toBe("tab");
    expect(a.personPressed(1_001)).toBe(true);
  });

  it("comes from a press, not from a mouse passing over or a key let go", () => {
    const a = new UserActivation();
    for (const type of ["mouseMove", "mouseEnter", "mouseWheel", "keyUp", "char"]) a.note(type, 0);
    expect(a.decide(1, false)).toBe("in-place");
    for (const type of ["mouseDown", "rawKeyDown", "keyDown", "touchEnd"]) {
      const pressed = new UserActivation();
      pressed.note(type, 0);
      expect(pressed.decide(1, false)).toBe("tab");
    }
  });
});

describe("sendAsAgent", () => {
  /** What `personPressed` reads while the page is answering `send`. */
  const pressedDuring = (a: UserActivation, answer: () => Promise<unknown> = async () => ({})) => {
    const seen: boolean[] = [];
    const send = sendAsAgent(a, async () => { seen.push(a.personPressed(0)); return answer(); });
    return { send, seen };
  };

  it("sends the agent's Input commands as its own, until they answer (#561)", async () => {
    // THE MUTANT: send Input.* straight to the page, and the agent's click in the page the person is
    // typing in opens a tab that takes the keyboard.
    const a = new UserActivation();
    const { send, seen } = pressedDuring(a, async () => ({ ok: 1 }));
    await expect(send("Input.dispatchMouseEvent", { type: "mousePressed" })).resolves.toEqual({ ok: 1 });
    expect(seen).toEqual([false]);
    expect(a.personPressed(0)).toBe(true);
  });

  it("leaves its other commands alone", async () => {
    // THE MUTANT: send every command asAgent, and a person's click while the agent reads the page
    // (Runtime.evaluate) opens a tab that leaves the keyboard behind.
    const a = new UserActivation();
    const { send, seen } = pressedDuring(a);
    await send("Runtime.evaluate", { expression: "1" });
    expect(seen).toEqual([true]);
  });

  it("ends a command that fails, so the person's next press is theirs", async () => {
    // THE MUTANT: count down only on success, and one failed CDP click marks every press after it as the agent's.
    const a = new UserActivation();
    const { send, seen } = pressedDuring(a, async () => { throw new Error("detached"); });
    await expect(send("Input.dispatchKeyEvent", { type: "keyDown" })).rejects.toThrow("detached");
    expect(seen).toEqual([false]);
    a.note("mouseDown", 0);
    expect(a.personPressed(1)).toBe(true);
  });

  it("sends as before for a page with no activation", async () => {
    const send = vi.fn(async () => "sent");
    await expect(sendAsAgent(undefined, send)("Input.dispatchMouseEvent", { type: "mousePressed" })).resolves.toBe("sent");
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", { type: "mousePressed" });
  });
});

describe("hostedTab", () => {
  /** The person pressed in the page that had the keyboard. */
  const PERSON: WindowKeyboard = { openerFocused: true, personPressed: true };
  it("lets Chromium make the window, so window.open answers a live window, and hosts it as the tab", () => {
    // Denying the window and loading its address fresh in a new tab makes window.open answer null, as
    // if the popup were blocked, and loses the window.opener link and a POST form's body.
    // THE MUTANT: answer "deny".
    const adopt = vi.fn();
    const r = hostedTab({ partition: P }, () => "tab", PERSON, adopt, () => {});
    expect(r.action).toBe("allow");
    const page = livePage();
    // THE MUTANT: make a page of our own here, and Electron throws — the window it made is not hosted.
    expect(r.createWindow({ webContents: page })).toBe(page);
    expect(adopt).toHaveBeenCalledWith(page, true);
    expect(page.close).not.toHaveBeenCalled();
  });

  it("gives the tab the keyboard only when the opener had it and the person pressed for it (#561)", () => {
    // THE MUTANTS: drop `personPressed`, and the agent's click in the page the person is typing in
    // opens a tab that takes the keyboard; drop `openerFocused`, and a click in a page without the
    // keyboard takes it from wherever it was.
    const focused = (keyboard: WindowKeyboard) => {
      const adopt = vi.fn();
      hostedTab({ partition: P }, () => "tab", keyboard, adopt, () => {}).createWindow({ webContents: livePage() });
      return adopt.mock.calls[0]?.[1];
    };
    expect(focused(PERSON)).toBe(true);
    expect(focused({ openerFocused: true, personPressed: false })).toBe(false);
    expect(focused({ openerFocused: false, personPressed: true })).toBe(false);
  });

  it("goes in place when nobody pressed anything: no tab, and the pane shows the page Chromium made, kept alive", () => {
    // Measured on 2.19.0: a window.open(url) as a page loads, or from its timer, reaches the handler as
    // a foreground tab like a click's. THE MUTANTS: ignore `pressed`, and a page spawns tabs on its own;
    // close the page and load its address afresh, and window.open answers a window that is already
    // closed, and a POST form's body is lost (#543).
    const adopt = vi.fn();
    const inPlace = vi.fn();
    const page = livePage();
    expect(hostedTab({ partition: P }, () => "in-place", { openerFocused: false, personPressed: true }, adopt, inPlace).createWindow({ webContents: page })).toBe(page);
    expect(adopt).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    expect(inPlace).toHaveBeenCalledWith(page, false);
  });

  it("refuses a window past the press's tabs: closed, no tab, and the pane stays on its page", () => {
    // THE MUTANT: follow it in place like a window nobody pressed for, and the page that was pressed is gone.
    const adopt = vi.fn();
    const inPlace = vi.fn();
    const page = livePage();
    hostedTab({ partition: P }, () => "refuse", PERSON, adopt, inPlace).createWindow({ webContents: page });
    expect(page.close).toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(inPlace).not.toHaveBeenCalled();
  });

  describe("the keyboard", () => {
    const opened = (as: TabAnswer, keyboard: WindowKeyboard) => {
      const adopt = vi.fn();
      const inPlace = vi.fn();
      hostedTab({ partition: P }, () => as, keyboard, adopt, inPlace).createWindow({ webContents: { close: vi.fn() } });
      return [...adopt.mock.calls, ...inPlace.mock.calls][0]![1] as boolean;
    };
    /** The agent's CDP input in flight on the opener, as `personPressed` reads it then. */
    const duringAgentInput = () => {
      const activation = new UserActivation();
      let personPressed = true;
      void activation.asAgent(async () => { personPressed = activation.personPressed(0); });
      return personPressed;
    };

    it("a page shown in place takes it when the opener had it and nobody pressed", () => {
      // #557's keys-on row. THE MUTANT: never focus the page shown in place.
      expect(opened("in-place", { openerFocused: true, personPressed: true })).toBe(true);
    });

    it("a page shown in place leaves it where it is when the opener did not have it", () => {
      // #557's keys-off row: a timer's window must not take the keys typed into the prompter.
      // THE MUTANT: always focus the page shown in place.
      expect(opened("in-place", { openerFocused: false, personPressed: true })).toBe(false);
    });

    it("a page shown in place during the agent's input still takes it from the opener, which it covers", () => {
      // The opener held the person's keyboard and is now hidden behind the new page in the same pane:
      // left there, their keys would go to a page they can't see. THE MUTANT: give the page shown in
      // place the tab's rule (#564's `personPressed` too).
      const personPressed = duringAgentInput();
      expect(personPressed).toBe(false);
      expect(opened("in-place", { openerFocused: true, personPressed })).toBe(true);
    });
  });

  it("outlives the page that opened it, as a tab does, in the pane's profile", () => {
    // THE MUTANT: drop outlivesOpener, and closing the page that opened a tab closes the tab too.
    const r = hostedTab({ partition: P, sandbox: true }, () => "tab", PERSON, () => {}, () => {});
    expect(r.outlivesOpener).toBe(true);
    expect(r.overrideBrowserWindowOptions).toEqual({ webPreferences: { partition: P, sandbox: true } });
  });
});

describe("popupBounds", () => {
  /** A Realm window on a laptop display, below the menu bar. */
  const realm = { x: 100, y: 60, width: 1400, height: 900 };
  const workArea = { x: 0, y: 25, width: 1728, height: 1092 };

  it("opens at the size the page asked for, centred over the Realm window", () => {
    // The mutant that ignores the features opens Google's 500×600 picker at 800×600.
    expect(popupBounds("width=500,height=600", realm, workArea)).toEqual({ x: 550, y: 210, width: 500, height: 600 });
  });

  it("goes where the page put it, when it said", () => {
    // Sites centre their popup on their own window with left/top; the mutant that drops them re-centres.
    expect(popupBounds("width=500,height=600,left=300,top=120", realm, workArea)).toEqual({ x: 300, y: 120, width: 500, height: 600 });
    expect(popupBounds("width=500,height=600,screenX=310,screenY=130", realm, workArea)).toEqual({ x: 310, y: 130, width: 500, height: 600 });
  });

  it("reads features the way pages write them: spaced, any case, innerWidth for width", () => {
    expect(popupBounds("popup, innerWidth = 450, HEIGHT=550", realm, workArea)).toMatchObject({ width: 450, height: 550 });
  });

  it("a page that names no size gets Electron's default, centred", () => {
    expect(popupBounds("", realm, workArea)).toEqual({ x: 400, y: 210, width: 800, height: 600 });
    expect(popupBounds("width=wide", realm, workArea)).toMatchObject({ width: 800 });
  });

  it("stays on the Realm window's display, whole, and no smaller than Chromium allows", () => {
    // The mutant without the clamp opens it off screen, or larger than the screen it is on.
    expect(popupBounds("width=500,height=600,left=-900,top=5000", realm, workArea)).toEqual({ x: 0, y: 517, width: 500, height: 600 });
    expect(popupBounds("width=5000,height=5000", realm, workArea)).toEqual({ x: 0, y: 25, width: 1728, height: 1092 });
    expect(popupBounds("width=10,height=0", realm, workArea)).toMatchObject({ width: 100, height: 100 });
  });
});

describe("popupTitle", () => {
  it("puts the site first, then what the page calls itself", () => {
    expect(popupTitle("https://accounts.google.com/v3/signin/identifier?x=1", "Sign in - Google Accounts")).toBe("accounts.google.com — Sign in - Google Accounts");
  });

  it("a page cannot push its host out of the title bar by naming another", () => {
    // The mutant that puts the page's title first lets a lookalike read as the real sign-in.
    expect(popupTitle("https://evil.example/login", "accounts.google.com")).toBe("evil.example — accounts.google.com");
  });

  it("drops a title that is only the page's own address, and keeps the port", () => {
    expect(popupTitle("http://127.0.0.1:18803/auth", "127.0.0.1:18803/auth")).toBe("127.0.0.1:18803");
    expect(popupTitle("https://example.com/", "")).toBe("example.com");
  });

  it("a blank page has no site to name", () => {
    expect(popupTitle("about:blank", "")).toBe("");
    expect(popupTitle("about:blank", "Loading…")).toBe("Loading…");
  });
});

describe("toViewBounds", () => {
  it("scales by the zoom factor (dpr / scaleFactor) and insets to the grid", () => {
    // App zoomed to 150% on a 2x display: dpr = 3, scale = 2. The box is x 150 → 451.5, y 75 → 223.5.
    // This used to answer width 302 — a right edge at 452, half a pixel PAST the placeholder and
    // therefore over the divider beside it, which a WebContentsView paints on top of. 301 is the
    // last whole pixel still inside the box.
    expect(toViewBounds({ x: 100, y: 50, width: 201, height: 99 }, 3, 2)).toEqual({ x: 150, y: 75, width: 301, height: 148 });
  });
  it("clamps negative sizes and survives zero/garbage factors", () => {
    expect(toViewBounds({ x: 0, y: 0, width: -5, height: -1 }, 2, 2)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(toViewBounds({ x: 1, y: 2, width: 3, height: 4 }, 0, 0)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

/** The cookie jar every test below makes its views in, unless it says otherwise. */
const P = "persist:browser";

/** A fake ViewHandle that records calls and simulates the webContents state getters. */
function fakeView() {
  const nav = { url: "", title: "", loading: false, back: false, forward: false,
    entries: [] as { url: string; title: string }[], activeIndex: 0, zoom: 1, favicon: null as string | null,
    error: null as BrowserLoadError | null, ready: false, popups: [] as string[], scroll: { x: 0, y: 0 } as { x: number; y: number } | null,
    keyboard: false, muted: false, pid: 0 as number | null, typed: false };
  const calls: string[] = [];
  let hooks: ViewHooks | null = null;
  const handle: ViewHandle = {
    setBounds: (r) => calls.push(`bounds:${r.x},${r.y},${r.width},${r.height}`),
    setVisible: (v) => calls.push(`visible:${v}`),
    focus: () => calls.push("focus"),
    loadURL: (url) => { calls.push(`load:${url}`); nav.url = url; nav.loading = true; hooks?.emitState(); },
    goBack: () => calls.push("back"), goForward: () => calls.push("forward"),
    reload: () => calls.push("reload"), stop: () => calls.push("stop"),
    canGoBack: () => nav.back, canGoForward: () => nav.forward,
    getURL: () => nav.url, getTitle: () => nav.title, isLoading: () => nav.loading, getFavicon: () => nav.favicon,
    getLoadError: () => nav.error, isReady: () => nav.ready,
    history: () => ({ entries: nav.entries, activeIndex: nav.activeIndex }),
    goToIndex: (i) => calls.push(`goToIndex:${i}`),
    findInPage: (text, o) => calls.push(`find:${text}:${o.forward ? "forward" : "backward"}:${o.findNext ? "new" : "step"}`),
    stopFindInPage: () => calls.push("stop-find"),
    getZoomFactor: () => nav.zoom,
    setZoomFactor: (f) => { calls.push(`zoom:${f}`); nav.zoom = f; },
    print: () => calls.push("print"),
    popups: () => nav.popups,
    typed: () => nav.typed,
    readScroll: async () => { calls.push("readScroll"); return nav.scroll; },
    scrollAfterLoad: (x, y) => calls.push(`scrollAfterLoad:${x},${y}`),
    reclaim: () => calls.push("reclaim"),
    hasKeyboard: () => nav.keyboard,
    isAudioMuted: () => nav.muted,
    setAudioMuted: (muted) => { nav.muted = muted; },
    getOSProcessId: () => nav.pid,
    destroy: () => calls.push("destroy"),
  };
  return { handle, calls, nav, setHooks: (h: ViewHooks) => { hooks = h; }, getHooks: () => hooks! };
}

function makeHost(scaleFactor = 2, o: { guard?: (id: string) => Promise<KeepReason | null>; now?: () => number; windowGone?: () => boolean; pool?: HiddenViews } = {}) {
  const views = new Map<string, ReturnType<typeof fakeView>>();
  const states: BrowserViewState[] = [];
  const found: (FindResult & { id: string })[] = [];
  const findRequests: string[] = [];
  const emulations: { id: string; metrics: DeviceMetrics | null }[] = [];
  const tabs: { id: string; url: string; background: boolean; focus: boolean; page: string }[] = [];
  const closedTabs: string[] = [];
  const factory = vi.fn((id: string, hooks: ViewHooks, _partition: string, _page?: unknown) => {
    const v = fakeView(); v.setHooks(hooks); views.set(id, v); return v.handle;
  });
  const host = new BrowserPaneHost({
    createView: factory, sendState: (s) => states.push(s), scaleFactor: () => scaleFactor,
    sendFound: (m) => found.push(m), requestFind: (id) => findRequests.push(id),
    emulate: (id, metrics) => emulations.push({ id, metrics }), openTab: (m) => tabs.push(m),
    closeTab: (id) => closedTabs.push(id),
    ...(o.guard ? { guard: o.guard } : {}), ...(o.now ? { now: o.now } : {}), ...(o.windowGone ? { windowGone: o.windowGone } : {}),
    ...(o.pool ? { pool: o.pool } : {}),
  });
  return { host, views, states, factory, found, findRequests, emulations, tabs, closedTabs };
}

const alive = (v: ReturnType<typeof fakeView>) => !v.calls.includes("destroy");
/** A page Chromium made for a new tab, still open. */
const livePage = () => ({ close: vi.fn(), isDestroyed: () => false });
/** One that called window.close() already: closing it again throws, as Electron 45 does. */
const closedPage = () => ({ close: vi.fn(() => { throw new TypeError("Object has been destroyed"); }), isDestroyed: () => true });
/** One turn of the event loop: what a closed page's tab waits before it closes. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** One more browser than the budget can retain, named v0 (oldest) upward. */
const overBudget = (host: BrowserPaneHost) => {
  const ids = Array.from({ length: RETAINED_VIEW_LIMIT + 1 }, (_, i) => `v${i}`);
  for (const id of ids) host.create(id, "example.com", null, P);
  return ids;
};

describe("BrowserPaneHost", () => {
  it("create loads the (normalized) url and emits initial state; create is idempotent", () => {
    const { host, views, states, factory } = makeHost();
    host.create("b1", "example.com", null, P);
    expect(views.get("b1")!.calls).toContain("load:https://example.com");
    expect(states.at(-1)).toMatchObject({ id: "b1", url: "https://example.com", loading: true });
    host.create("b1", "https://other.example", null, P); // StrictMode remount: no reload, state re-emitted
    expect(factory).toHaveBeenCalledTimes(1);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
    expect(states.at(-1)!.id).toBe("b1");
  });

  it("splits the trail at where the view is standing, nearest first going back", () => {
    /* THE off-by-one mutant: include the active entry in either arm. Back would offer the page you
       are already on as its first row, and Forward would too — one of them a no-op wearing a title. */
    const { host, views } = makeHost();
    host.create("b1", "https://c.example", null, P);
    const v = views.get("b1")!;
    v.nav.entries = [
      { url: "https://a.example", title: "A" },
      { url: "https://b.example", title: "B" },
      { url: "https://c.example", title: "C" },
      { url: "https://d.example", title: "D" },
    ];
    v.nav.activeIndex = 2;
    // Nearest first: the page one press of Back away is the row nearest the button.
    expect(host.historyTrail("b1", "back")).toEqual([{ index: 1, label: "B" }, { index: 0, label: "A" }]);
    // Forward is walked in the order it would be walked.
    expect(host.historyTrail("b1", "forward")).toEqual([{ index: 3, label: "D" }]);
  });

  it("falls back to the url for a page that never set a title, and refuses both ends", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    const v = views.get("b1")!;
    v.nav.entries = [{ url: "https://a.example", title: "" }, { url: "https://b.example", title: "   " }];
    v.nav.activeIndex = 1;
    // A blank row in a menu is a row nobody can aim at.
    expect(host.historyTrail("b1", "back")).toEqual([{ index: 0, label: "https://a.example" }]);
    // Standing at the oldest entry there is nothing behind; at the newest, nothing ahead.
    v.nav.activeIndex = 0;
    expect(host.historyTrail("b1", "back")).toEqual([]);
    v.nav.activeIndex = 1;
    expect(host.historyTrail("b1", "forward")).toEqual([]);
    // A browser that is not open has no trail rather than throwing at the menu's call site.
    expect(host.historyTrail("nope", "back")).toEqual([]);
  });

  it("goToIndex reaches the view, and a missing one is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.goToIndex("b1", 3);
    expect(views.get("b1")!.calls).toContain("goToIndex:3");
    expect(() => host.goToIndex("nope", 1)).not.toThrow();
  });

  it("create with an empty url loads nothing (the pane's empty state, not about:blank)", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
  });

  it("navigate normalizes, consults the allowlist, and reports what it did", () => {
    const { host, views } = makeHost();
    host.create("b1", "", ["https://example.com"], P);
    expect(host.navigate("b1", "example.com")).toBe("https://example.com");
    expect(views.get("b1")!.calls).toContain("load:https://example.com");
    expect(host.navigate("b1", "evil.com")).toBeNull();
    expect(views.get("b1")!.calls).not.toContain("load:https://evil.com");
    expect(host.navigate("b1", "   ")).toBeNull();
    expect(host.navigate("nope", "example.com")).toBeNull(); // unknown id: refused, not thrown
  });

  it("create refuses to load a persisted url the allowlist no longer permits", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://evil.com", ["https://example.com"], P);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
  });

  it("the will-navigate consult reads the CURRENT allowlist, and setAllowlist swaps it live", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    const hooks = views.get("b1")!.getHooks();
    expect(hooks.allowNavigate("https://anywhere.example")).toBe(true); // null = allow-all
    host.setAllowlist("b1", ["https://example.com"]);
    expect(hooks.allowNavigate("https://anywhere.example")).toBe(false);
    expect(hooks.allowNavigate("https://example.com/x")).toBe(true);
  });

  it("a window.open funnels into an in-place navigation of the SAME view, allowlist included", () => {
    const { host, views } = makeHost();
    host.create("b1", "", ["https://example.com"], P);
    const hooks = views.get("b1")!.getHooks();
    hooks.openInPlace("https://example.com/popup");
    expect(views.get("b1")!.calls).toContain("load:https://example.com/popup");
    hooks.openInPlace("https://evil.com/popup");
    expect(views.get("b1")!.calls).not.toContain("load:https://evil.com/popup");
  });

  describe("a window nobody pressed for, shown in place (#543)", () => {
    /** b1 on `opener`, whose page has just opened `url` with no press behind it. */
    const openedInPlace = (url = "https://example.com/x", allowlist: string[] | null = ["https://example.com"], focused = false) => {
      const made = makeHost();
      made.host.create("b1", "https://example.com/opener", allowlist, P);
      made.host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
      const opener = made.views.get("b1")!;
      const page = livePage();
      opener.getHooks().adoptInPlace(url, page, focused);
      return { ...made, opener, page, front: made.views.get("b1")! };
    };

    it("hosts the page Chromium made in the opener's place, and never loads its address again", () => {
      // Loading the bare address is what left window.open a closed window and dropped a POST body.
      // THE MUTANT: loadURL the address in the view, as openInPlace does.
      const { factory, opener, front, page, states } = openedInPlace();
      expect(factory).toHaveBeenLastCalledWith("b1", expect.anything(), P, { page, url: "https://example.com/x" });
      expect(front).not.toBe(opener);
      expect([...opener.calls, ...front.calls].filter((c) => c.startsWith("load:https://example.com/x"))).toEqual([]);
      expect(page.close).not.toHaveBeenCalled();
      // Shown where the opener was, which goes off screen.
      expect(front.calls).toContain("bounds:0,0,200,100");
      expect(front.calls).toContain("visible:true");
      expect(opener.calls.at(-1)).toBe("visible:false");
      expect(states.at(-1)).toMatchObject({ id: "b1", canGoBack: true });
    });

    it("keeps the opener's page alive behind it, so the window it holds is a live one", () => {
      // THE MUTANT: destroy the opener, and a page waiting for the window to post back hears nothing.
      const { opener } = openedInPlace();
      expect(alive(opener)).toBe(true);
    });

    it("Back from the new page's first entry shows the opener's page again, as it was", () => {
      // Main navigated in place, so Back reloaded the opener. THE MUTANT: leave Back to the new page's
      // own history, which has nothing in it, and the opener's page is gone for good.
      const { host, opener, front, states } = openedInPlace();
      host.navAction("b1", "back");
      expect(alive(front)).toBe(false);
      expect(front.calls).not.toContain("back");
      expect(opener.calls).toContain("reclaim");
      expect(opener.calls.at(-1)).toBe("visible:true");
      expect(opener.calls.filter((c) => c.startsWith("load:"))).toEqual(["load:https://example.com/opener"]);
      expect(states.at(-1)).toMatchObject({ id: "b1", url: "https://example.com/opener", canGoBack: false });
    });

    it("Back inside the new page's own history stays on it", () => {
      // THE MUTANT: uncover the opener whenever there is one, and Back skips the new page's history.
      const { host, opener, front } = openedInPlace();
      front.nav.back = true;
      host.navAction("b1", "back");
      expect(front.calls).toContain("back");
      expect(alive(front)).toBe(true);
      expect(opener.calls).not.toContain("reclaim");
    });

    it("closes a page outside the pane's allowlist and leaves the opener where it is", () => {
      const { page, opener, front, factory } = openedInPlace("https://evil.com/x");
      expect(page.close).toHaveBeenCalled();
      expect(front).toBe(opener);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("counts the popups of the opener behind as the browser's: a discard would close them with it", () => {
      // What keeps the browser from a discard ("popup"). THE MUTANT: read only the page in front, and
      // a sign-in window the opener has open goes when the sweep takes the browser.
      const { host, opener, front } = openedInPlace();
      opener.nav.popups = ["https://accounts.google.com/o/oauth2/v2/auth"];
      front.nav.popups = ["https://example.com/share"];
      expect(host.popupsOf("b1")).toEqual(["https://example.com/share", "https://accounts.google.com/o/oauth2/v2/auth"]);
    });

    it("counts what was typed into the opener behind as the browser's: a discard would lose it with it", () => {
      // What keeps the browser from a discard ("form"). THE MUTANT: read only the page in front, and a
      // form half filled in on the opener is gone when the page shown in its place is closed to get back.
      const { host, opener, front } = openedInPlace();
      expect(host.typedOf("b1")).toBe(false);
      opener.nav.typed = true;
      expect(host.typedOf("b1")).toBe(true);
      opener.nav.typed = false;
      front.nav.typed = true;
      expect(host.typedOf("b1")).toBe(true);
      expect(host.typedOf("nope")).toBe(false);
    });

    it("closes the opener's page with the browser", () => {
      // THE MUTANT: destroy only the page in front, and the opener runs on unseen with nothing to end it.
      const { host, opener, front } = openedInPlace();
      host.destroy("b1");
      expect(alive(front)).toBe(false);
      expect(alive(opener)).toBe(false);
    });

    it("the page behind cannot move the pane: its own windows and links go nowhere", () => {
      // It is off screen, so only its timers can ask. THE MUTANT: let it, and a page that opens a window
      // on a timer piles up pages behind the pane without end, or drags the pane off the page in front.
      const { host, opener, front } = openedInPlace();
      const again = livePage();
      opener.getHooks().adoptInPlace("https://example.com/y", again, false);
      expect(again.close).toHaveBeenCalled();
      opener.getHooks().openInPlace("https://example.com/z");
      expect(front.calls.filter((c) => c.startsWith("load:"))).toEqual([]);
      expect(host.navigate("b1", "https://example.com/w")).toBe("https://example.com/w");
      expect(front.calls).toContain("load:https://example.com/w");
    });

    const focuses = (v: ReturnType<typeof fakeView>) => v.calls.filter((c) => c === "focus").length;

    it("gives the new page the keyboard when the opener had it", () => {
      // The opener held the keys, and on main the page shown in its place was the same webContents.
      // THE MUTANT: never focus the new page, and the keys go on landing in the page hidden behind it.
      const { host, front } = openedInPlace(undefined, undefined, true);
      expect(focuses(front)).toBe(1);
      host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
      expect(focuses(front)).toBe(1);
    });

    it("leaves the keyboard where it is when the opener did not have it", () => {
      // The caret is in the prompter, or an agent's run opened it. THE MUTANT: always focus the new
      // page, and the person's draft stops taking keys.
      const { host, front } = openedInPlace(undefined, undefined, false);
      host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
      expect(focuses(front)).toBe(0);
    });

    it("waits for the pane to show the new page before giving it the keyboard", () => {
      // A hidden view holding the keyboard swallows the keys.
      const made = makeHost();
      made.host.create("b1", "https://example.com/opener", null, P);
      made.views.get("b1")!.getHooks().adoptInPlace("https://example.com/x", livePage(), true);
      const front = made.views.get("b1")!;
      expect(focuses(front)).toBe(0);
      made.host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
      expect(focuses(front)).toBe(1);
    });

    it("gives the opener back the keyboard the page in front had", () => {
      // THE MUTANT: never focus the opener when it is uncovered, and the keys go to a page that is gone.
      const { host, opener, front } = openedInPlace();
      front.nav.keyboard = true;
      host.navAction("b1", "back");
      expect(focuses(opener)).toBe(1);
    });

    it("leaves the keyboard alone on Back when the page in front did not have it", () => {
      // Back pressed in the pane's own bar: the keyboard is in the window, not the page. THE MUTANT:
      // always focus the opener, and the keyboard leaves wherever the person put it.
      const { host, opener } = openedInPlace(undefined, undefined, true);
      host.navAction("b1", "back");
      expect(focuses(opener)).toBe(0);
    });

    it("shows the opener again when the page in front closes itself, and keeps the tab", async () => {
      // window.open, postMessage back, window.close(): the usual end of this. THE MUTANTS: ignore the
      // close, and the pane is left on a page that is gone, with the opener hidden behind it for good;
      // close the tab as for a page with nothing behind it, and the opener goes with it.
      const { host, opener, front, states, closedTabs } = openedInPlace();
      opener.nav.title = "Opener";
      const shown = states.length;
      expect(() => front.getHooks().pageClosed()).not.toThrow();
      await turn();
      expect(closedTabs).toEqual([]);
      expect(host.has("b1")).toBe(true);
      expect(opener.calls).toContain("reclaim");
      expect(opener.calls.at(-1)).toBe("visible:true");
      expect(opener.calls.filter((c) => c.startsWith("load:"))).toEqual(["load:https://example.com/opener"]);
      expect(states.length).toBe(shown + 1);
      expect(states.at(-1)).toMatchObject({ id: "b1", url: "https://example.com/opener", title: "Opener", canGoBack: false });
    });

    it("hands the keyboard back when the page in front closes itself holding it", () => {
      const { opener, front } = openedInPlace(undefined, undefined, true);
      front.nav.keyboard = true;
      front.getHooks().pageClosed();
      expect(focuses(opener)).toBe(1);
    });

    it("closes the tab of a page shown in place that closes itself once Back has emptied what was behind it", async () => {
      // Back to the opener, then the opener closes itself: nothing waits behind it, so it is a tab's
      // page closing itself (#559). THE MUTANT: uncover on every close, from an empty stack.
      const { host, opener, closedTabs } = openedInPlace();
      host.navAction("b1", "back");
      expect(() => opener.getHooks().pageClosed()).not.toThrow();
      await turn();
      expect(closedTabs).toEqual(["b1"]);
      expect(host.has("b1")).toBe(false);
    });

    it("drops and destroys an opener that closes itself from behind the page in front, and nothing else", async () => {
      // A page waiting behind is a page too, and may call window.close() from a timer. THE MUTANTS:
      // take its close for the front page's, and the pane uncovers or its tab closes; keep it behind,
      // and Back shows a page that is gone; send no state, and the pane's Back stays lit for nothing;
      // drop it without destroying it, and it is the one page that leaves without being torn down.
      // Its popups close either way: Electron closes a window.open window with its opener.
      const { host, opener, front, states, closedTabs } = openedInPlace();
      front.nav.title = "Child";
      opener.nav.pid = 11; front.nav.pid = 12;
      expect(states.at(-1)).toMatchObject({ canGoBack: true });
      opener.getHooks().pageClosed();
      await turn();
      expect(opener.calls).toContain("destroy");
      expect(closedTabs).toEqual([]);
      expect(host.has("b1")).toBe(true);
      expect(front.calls).not.toContain("destroy");
      expect(opener.calls).not.toContain("reclaim");
      expect(states.at(-1)).toMatchObject({ id: "b1", title: "Child", canGoBack: false });
      expect(host.processes().map((p) => p.pid)).toEqual([12]);
      host.navAction("b1", "back");
      expect(front.calls).not.toContain("destroy");
      expect(opener.calls).not.toContain("reclaim");
    });

    it("drops only the opener that closed itself when several wait behind", () => {
      // THE MUTANT: drop the last one behind instead of the one that went, and Back shows a page that
      // is gone while the live one is lost.
      const { host, views, opener, front } = openedInPlace();
      front.getHooks().adoptInPlace("https://example.com/y", livePage(), false);
      const third = views.get("b1")!;
      opener.getHooks().pageClosed();
      expect(third.calls).not.toContain("destroy");
      host.navAction("b1", "back");
      expect(front.calls).toContain("reclaim");
      expect(third.calls).toContain("destroy");
      host.navAction("b1", "back");
      expect(opener.calls).not.toContain("reclaim");
    });

    it("does nothing when a page the pane closed reports closing", async () => {
      // Back destroys the page in front, and its close arrives after. THE MUTANT: act on a close from
      // a page the browser no longer has, and that late close uncovers the next opener or closes the tab.
      const { host, views, opener, front, closedTabs } = openedInPlace();
      front.getHooks().adoptInPlace("https://example.com/y", livePage(), false);
      const third = views.get("b1")!;
      host.navAction("b1", "back");
      expect(front.calls).toContain("reclaim");
      third.getHooks().pageClosed();
      await turn();
      expect(alive(front)).toBe(true);
      expect(opener.calls).not.toContain("reclaim");
      expect(closedTabs).toEqual([]);
    });

    it("mutes the page waiting behind, and gives it its sound back when Back shows it again", () => {
      // Hidden, it plays on with nothing on screen to stop it from. THE MUTANT: leave it unmuted.
      const { host, opener, front } = openedInPlace();
      expect(opener.nav.muted).toBe(true);
      expect(front.nav.muted).toBe(false);
      host.navAction("b1", "back");
      expect(opener.nav.muted).toBe(false);
    });

    it("leaves a page that was muted before it waited muted when it comes back", () => {
      // THE MUTANT: unmute whatever comes back, and a page Realm had muted starts making sound.
      const made = makeHost();
      made.host.create("b1", "https://example.com/opener", null, P);
      const opener = made.views.get("b1")!;
      opener.nav.muted = true;
      opener.getHooks().adoptInPlace("https://example.com/x", livePage(), false);
      made.views.get("b1")!.getHooks().pageClosed();
      expect(opener.calls).toContain("reclaim");
      expect(opener.nav.muted).toBe(true);
    });

    it("counts the pages waiting behind a browser as that browser's, off screen since they were covered", () => {
      // The resource report names renderers by these. THE MUTANT: list only the page in front, and a
      // parked opener's renderer shows up as nobody's.
      let now = 1_000;
      const made = makeHost(2, { now: () => now });
      made.host.create("b1", "https://example.com/opener", null, P);
      made.host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
      const opener = made.views.get("b1")!;
      opener.nav.pid = 11; opener.nav.title = "Opener";
      now = 2_000;
      opener.getHooks().adoptInPlace("https://example.com/x", livePage(), false);
      const front = made.views.get("b1")!;
      front.nav.pid = 12; front.nav.title = "Child";
      made.host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
      expect(made.host.processes()).toEqual([
        { browserId: "b1", pid: 11, title: "Opener", hiddenSince: 2_000 },
        { browserId: "b1", pid: 12, title: "Child", hiddenSince: null },
      ]);
      // A page that has gone has no process to name.
      front.nav.pid = null;
      expect(made.host.processes()).toEqual([{ browserId: "b1", pid: 11, title: "Opener", hiddenSince: 2_000 }]);
    });

    it("keeps at most PARKED_OPENERS pages behind one pane, closing the oldest first", () => {
      // THE MUTANT: no limit, and a chain of pages each opening the next keeps every one running.
      const { host, views } = makeHost();
      host.create("b1", "https://example.com/0", null, P);
      const chain = [views.get("b1")!];
      for (let i = 1; i <= PARKED_OPENERS + 1; i++) {
        chain.at(-1)!.getHooks().adoptInPlace(`https://example.com/${i}`, livePage(), false);
        chain.push(views.get("b1")!);
      }
      expect(alive(chain[0]!)).toBe(false);
      expect(chain.slice(1).every(alive)).toBe(true);
    });

    it("Back past the kept openers loads the closed one's address again, as main's Back did", () => {
      // The bound is on renderers left running, not on where Back can go. THE MUTANT: forget the closed
      // opener, and Back stops one page short of where the person started.
      const { host, views, states } = makeHost();
      host.create("b1", "https://example.com/0", null, P);
      const chain = [views.get("b1")!];
      for (let i = 1; i <= PARKED_OPENERS + 1; i++) {
        chain.at(-1)!.getHooks().adoptInPlace(`https://example.com/${i}`, livePage(), false);
        chain.push(views.get("b1")!);
      }
      for (let i = 0; i < PARKED_OPENERS; i++) host.navAction("b1", "back");
      const last = chain[1]!;
      expect(states.at(-1)).toMatchObject({ id: "b1", canGoBack: true });
      host.navAction("b1", "back");
      expect(last.calls.at(-1)).toBe("load:https://example.com/0");
      expect(alive(last)).toBe(true);
      expect(states.at(-1)).toMatchObject({ id: "b1", url: "https://example.com/0" });
    });

    it("Back past the kept openers loads a closed one's address only if the allowlist still lets it in", () => {
      // THE MUTANT: load the remembered address straight into the view, past the check navigate makes.
      const { host, views } = makeHost();
      host.create("b1", "https://example.com/0", ["https://example.com"], P);
      const chain = [views.get("b1")!];
      for (let i = 1; i <= PARKED_OPENERS + 1; i++) {
        chain.at(-1)!.getHooks().adoptInPlace(`https://example.com/${i}`, livePage(), false);
        chain.push(views.get("b1")!);
      }
      for (let i = 0; i < PARKED_OPENERS; i++) host.navAction("b1", "back");
      host.setAllowlist("b1", ["https://other.com"]);
      host.navAction("b1", "back");
      expect(chain[1]!.calls.filter((c) => c.startsWith("load:"))).toEqual([]);
    });

    it("tells each page whether it is the one its browser shows", () => {
      // What the passkey and password brokers ask before acting on a page's request. THE MUTANT:
      // answer true for every page, and the opener hidden behind can raise a fingerprint prompt.
      const { host, opener, front } = openedInPlace();
      expect(opener.getHooks().inFront()).toBe(false);
      expect(front.getHooks().inFront()).toBe(true);
      host.navAction("b1", "back");
      expect(opener.getHooks().inFront()).toBe(true);
      expect(front.getHooks().inFront()).toBe(false);
    });

    it("a hook a factory calls while it is still making the view throws nothing and moves nothing", () => {
      // Not done by Electron's factory today. THE MUTANT: read the handle being made before it is
      // assigned, and the hook throws a ReferenceError out of `create`.
      const made = makeHost();
      made.factory.mockImplementationOnce((id, hooks) => {
        hooks.emitState();
        expect(hooks.inFront()).toBe(false);
        const v = fakeView(); v.setHooks(hooks); made.views.set(id, v); return v.handle;
      });
      expect(() => made.host.create("b1", "https://example.com/", null, P)).not.toThrow();
      expect(made.host.has("b1")).toBe(true);
    });

    describe("a window closing with a page shown in place", () => {
      // #559 measured, on macOS, the window's "closed" firing before its pages' "destroyed", and the
      // factory hears none of those as a page closing itself. These hold the host to the same if a
      // close does reach it while the window goes, from either page first.
      const chainOf = (pages: number) => {
        let gone = false;
        const made = makeHost(2, { windowGone: () => gone });
        made.host.create("b1", "https://example.com/0", null, P);
        made.host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
        const chain = [made.views.get("b1")!];
        for (let i = 1; i <= pages; i++) {
          chain.at(-1)!.getHooks().adoptInPlace(`https://example.com/${i}`, livePage(), true);
          chain.push(made.views.get("b1")!);
        }
        chain.at(-1)!.nav.keyboard = true;
        return { ...made, chain, closeWindow: () => { gone = true; } };
      };
      const quiet = (v: ReturnType<typeof fakeView>, from: number) =>
        v.calls.slice(from).filter((c) => c === "reclaim" || c === "focus" || c === "visible:true" || c.startsWith("bounds:"));

      for (const [order, pages] of [["the page behind first", 1], ["the page in front first", 1], ["the page behind first, two shown in place", 2], ["the page in front first, two shown in place", 2]] as const) {
        it(`touches no page and closes no tab: ${order}`, async () => {
          // THE MUTANT: no window check in pageClosed, and the front page's close shows, unmutes and
          // focuses the page behind it on a window that is going.
          const { host, chain, states, closedTabs, closeWindow } = chainOf(pages);
          const marks = chain.map((v) => v.calls.length);
          const sent = states.length;
          closeWindow();
          const closing = order.startsWith("the page in front") ? [...chain].reverse() : chain;
          for (const v of closing) v.getHooks().pageClosed();
          await turn();
          chain.forEach((v, i) => expect(quiet(v, marks[i]!)).toEqual([]));
          expect(chain.slice(0, -1).every((v) => v.nav.muted)).toBe(true);
          expect(states.length).toBe(sent);
          expect(closedTabs).toEqual([]);
          host.destroyAll();
          expect(chain.every((v) => !alive(v))).toBe(true);
        });
      }

      it("forgets the browser before destroying its pages, so a close any of them reports on the way is nobody's", async () => {
        // A factory that did not mark its own destroy would report each page closing. THE MUTANT:
        // forget the browser after its pages, and the page behind is dropped, the one in front taken
        // for a tab closing itself, and its tab closed.
        const { host, chain, states, closedTabs } = chainOf(2);
        for (const v of chain) {
          const destroy = v.handle.destroy;
          v.handle.destroy = () => { destroy(); v.getHooks().pageClosed(); };
        }
        const sent = states.length;
        host.destroyAll();
        await turn();
        expect(chain.every((v) => !alive(v))).toBe(true);
        expect(states.length).toBe(sent);
        expect(closedTabs).toEqual([]);
      });
    });

    describe("a page waiting behind that has already gone", () => {
      /** Its page is gone: destroying it again throws, as a webContents that is gone does. */
      const gone = (v: ReturnType<typeof fakeView>) => {
        v.handle.destroy = () => { v.calls.push("destroy"); throw new TypeError("Object has been destroyed"); };
      };
      const destroys = (v: ReturnType<typeof fakeView>) => v.calls.filter((c) => c === "destroy").length;
      /** b1 with two pages shown in place, so two wait behind the one in front. */
      const twoBehind = () => {
        const made = openedInPlace();
        made.front.getHooks().adoptInPlace("https://example.com/y", livePage(), false);
        return { ...made, middle: made.front, front: made.views.get("b1")! };
      };

      for (const teardown of ["destroy", "destroyAll"] as const) {
        it(`is destroyed once when it closes itself, and not again by ${teardown}`, () => {
          // THE MUTANTS: keep a page that closed itself behind, and the browser's teardown destroys it
          // again; drop it without destroying it, and it is the one page that leaves without being
          // torn down.
          const { host, opener, middle, front } = twoBehind();
          gone(opener);
          opener.getHooks().pageClosed();
          expect(destroys(opener)).toBe(1);
          if (teardown === "destroy") host.destroy("b1"); else host.destroyAll();
          expect(destroys(opener)).toBe(1);
          expect([middle, front].every((v) => !alive(v))).toBe(true);
          expect(host.has("b1")).toBe(false);
        });

        it(`leaves ${teardown} destroying the rest when one went with its window`, () => {
          // THE MUTANT: destroy the pages behind unguarded, and the first that throws leaves the rest
          // of the browser's pages running.
          const { host, opener, middle, front } = twoBehind();
          gone(opener);
          expect(() => (teardown === "destroy" ? host.destroy("b1") : host.destroyAll())).not.toThrow();
          expect([opener, middle, front].every((v) => destroys(v) === 1)).toBe(true);
          expect(host.has("b1")).toBe(false);
        });
      }

      it("leaves a discard destroying the rest of the browser's pages", async () => {
        // THE MUTANT: destroy the pages behind unguarded, and the discard throws with the page in
        // front still running.
        const { host, opener, middle, front } = twoBehind();
        gone(opener);
        host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, false);
        await expect(host.discard("b1")).resolves.toBe(true);
        expect([opener, middle, front].every((v) => destroys(v) === 1)).toBe(true);
        expect(host.isDiscarded("b1")).toBe(true);
      });

      it("leaves the oldest closed past PARKED_OPENERS, and the next page shown", () => {
        // THE MUTANT: destroy the oldest unguarded, and the window that pushed it out is never shown.
        const { host, views, states } = makeHost();
        host.create("b1", "https://example.com/0", null, P);
        host.setBounds("b1", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
        const chain = [views.get("b1")!];
        for (let i = 1; i <= PARKED_OPENERS; i++) {
          chain.at(-1)!.getHooks().adoptInPlace(`https://example.com/${i}`, livePage(), false);
          chain.push(views.get("b1")!);
        }
        chain[0]!.nav.url = "https://example.com/0";
        gone(chain[0]!);
        expect(() => chain.at(-1)!.getHooks().adoptInPlace("https://example.com/last", livePage(), false)).not.toThrow();
        expect(destroys(chain[0]!)).toBe(1);
        const last = views.get("b1")!;
        expect(chain).not.toContain(last);
        expect(last.calls).toContain("visible:true");
        for (let i = 0; i < PARKED_OPENERS; i++) host.navAction("b1", "back");
        expect(states.at(-1)).toMatchObject({ id: "b1", canGoBack: true });
      });
    });
  });

  it("hosts the page Chromium made for a new tab, and never loads its address again", () => {
    // Loading the bare address is what lost a POST form's body and the page's window.opener link.
    // THE MUTANT: load the url in `create` as for any other browser.
    const { host, views, tabs, factory } = makeHost();
    host.create("b1", "", ["https://example.com"], P);
    const page = livePage();
    views.get("b1")!.getHooks().openTab("https://example.com/echo", true, page, true);
    expect(tabs).toEqual([{ id: "b1", url: "https://example.com/echo", background: true, focus: true, page: expect.any(String) }]);
    host.claimTab(tabs[0]!.page, "b2");
    host.create("b2", "https://example.com/echo", ["https://example.com"], P);
    // …named by the address it was opened on, which the bar shows until the page commits: an empty one
    // reads as a blank tab, and the pane puts the keyboard in its address field.
    expect(factory).toHaveBeenLastCalledWith("b2", expect.anything(), P, { page, url: "https://example.com/echo" });
    expect(views.get("b2")!.calls.filter((c) => c.startsWith("load:"))).toEqual([]);
    expect(page.close).not.toHaveBeenCalled();
    // The page that was clicked on stays where it was.
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toEqual([]);
  });

  it("never hosts a page in another profile's tab: that page goes, and the address loads in the jar asked for", () => {
    // THE MUTANT: hand the page over whatever the partition, and one profile's sign-ins show in another's tab.
    const { host, views, tabs, factory } = makeHost();
    host.create("b1", "", null, P);
    const page = livePage();
    views.get("b1")!.getHooks().openTab("https://example.com/docs", false, page, false);
    host.claimTab(tabs[0]!.page, "b2");
    host.create("b2", "https://example.com/docs", null, "persist:browser-other");
    expect(page.close).toHaveBeenCalled();
    expect(factory).toHaveBeenLastCalledWith("b2", expect.anything(), "persist:browser-other", undefined);
    expect(views.get("b2")!.calls).toContain("load:https://example.com/docs");
  });

  it("closes a page outside the pane's allowlist instead of making it a tab", () => {
    const { host, views, tabs } = makeHost();
    host.create("b1", "", ["https://example.com"], P);
    const page = livePage();
    views.get("b1")!.getHooks().openTab("https://evil.com/docs", false, page, false);
    expect(tabs).toEqual([]);
    expect(page.close).toHaveBeenCalled();
  });

  it("closes a page no tab claims, and one whose browser closes before its pane showed it", () => {
    // THE MUTANT: forget the timer, and a tab the renderer never made leaves a page running unseen.
    vi.useFakeTimers();
    try {
      const { host, views, tabs } = makeHost();
      host.create("b1", "", null, P);
      const unclaimed = livePage();
      views.get("b1")!.getHooks().openTab("https://example.com/a", false, unclaimed, false);
      vi.advanceTimersByTime(UNCLAIMED_TAB_MS - 1);
      expect(unclaimed.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(unclaimed.close).toHaveBeenCalled();

      const closed = livePage();
      views.get("b1")!.getHooks().openTab("https://example.com/b", true, closed, false);
      host.claimTab(tabs[1]!.page, "b3");
      vi.advanceTimersByTime(UNCLAIMED_TAB_MS);
      expect(closed.close).not.toHaveBeenCalled(); // claimed: a background tab may wait unseen
      host.destroy("b3");
      expect(closed.close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("says a page asked for its tab without the keyboard, so the tab does not take it", () => {
    // An agent's click lands in a page the person is not typing in. THE MUTANT: always send focus: true,
    // and the keys going to the prompter land in a page they never opened.
    const { host, views, tabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, livePage(), false);
    expect(tabs[0]).toMatchObject({ focus: false });
  });

  it("gives a new tab's page the keyboard the person's page had, once, when its pane first shows it", () => {
    // A person clicked a target=_blank link: the keys they type next are the new page's, as in any
    // browser. THE MUTANT: never focus the view, and they go on landing in the page now behind it.
    const { host, views, tabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, livePage(), true);
    host.claimTab(tabs[0]!.page, "b2");
    host.create("b2", "https://example.com/a", null, P);
    const focuses = () => views.get("b2")!.calls.filter((c) => c === "focus").length;
    host.setBounds("b2", { x: 0, y: 0, width: 200, height: 100 }, 2, false);
    expect(focuses()).toBe(0); // not on screen yet: a hidden view holding the keyboard swallows it
    host.setBounds("b2", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
    host.setBounds("b2", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
    expect(focuses()).toBe(1); // the next frame's sync must not take it back from wherever it went
  });

  it("leaves the keyboard where it is for a ⌘- or middle-click's tab, even once the person shows it", () => {
    // THE MUTANT: focus a background tab the first time it shows, and the keyboard jumps out of the
    // page the person went on reading into one they only switched to look at.
    const { host, views, tabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", true, livePage(), true);
    host.claimTab(tabs[0]!.page, "b2");
    host.create("b2", "https://example.com/a", null, P);
    host.setBounds("b2", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
    expect(views.get("b2")!.calls).not.toContain("focus");
  });

  it("leaves the keyboard alone when the page that opened the tab did not have it", () => {
    // An agent's click. THE MUTANT: focus every hosted page, and the prompter's draft stops taking keys.
    const { host, views, tabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, livePage(), false);
    host.claimTab(tabs[0]!.page, "b2");
    host.create("b2", "https://example.com/a", null, P);
    host.setBounds("b2", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
    expect(views.get("b2")!.calls).not.toContain("focus");
  });

  it("closes the tab whose page closed itself, and never reads the dead page again", async () => {
    // A page a script opened may call window.close(), and Chromium lets it: the web contents go, and
    // every getter on the handle throws "Object has been destroyed". THE MUTANT: keep the view, and the
    // next state or bounds sync reads a page that is not there while the tab sits on a blank view.
    const { host, views, tabs, factory, states, closedTabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, livePage(), true);
    host.claimTab(tabs[0]!.page, "b2");
    host.create("b2", "https://example.com/a", null, P);
    const closed = views.get("b2")!;
    for (const getter of ["getURL", "getTitle", "isLoading", "canGoBack", "canGoForward", "isReady", "setBounds", "setVisible", "focus"] as const) {
      closed.handle[getter] = () => { throw new TypeError("Object has been destroyed"); };
    }
    closed.getHooks().pageClosed();
    await turn();
    expect(closedTabs).toEqual(["b2"]);
    expect(host.has("b2")).toBe(false);
    const sent = states.length;
    host.setBounds("b2", { x: 0, y: 0, width: 200, height: 100 }, 2, true);
    host.setDevice("b2", "phone");
    expect(states.length).toBe(sent);
    // Its pane showing it again before the tab closes gets a page, not the dead one.
    host.create("b2", "https://example.com/a", null, P);
    expect(factory).toHaveBeenLastCalledWith("b2", expect.anything(), P, undefined);
    expect(views.get("b2")!.calls).toContain("load:https://example.com/a");
    expect(views.get("b1")!.calls).not.toContain("destroy");
  });

  it("closes the tab whose page closed itself before its pane made the view, and makes no view of it", async () => {
    // A page that calls window.close() in its <head> can be gone before the renderer gets to
    // browser:create, and `new WebContentsView` throws on it ("options.webContents must be a
    // WebContents"), leaving the tab on a blank pane. THE MUTANT: hand the dead page to createView.
    const { host, views, tabs, factory, closedTabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, closedPage(), true);
    host.claimTab(tabs[0]!.page, "b2");
    factory.mockClear();
    host.create("b2", "https://example.com/a", null, P);
    expect(factory).not.toHaveBeenCalled();
    expect(host.has("b2")).toBe(false);
    await turn();
    expect(closedTabs).toEqual(["b2"]);
  });

  it("leaves a page that already closed itself alone wherever a waiting page is closed", () => {
    // Closing it again throws "Object has been destroyed": from the unclaimed timer that is an uncaught
    // exception in main, and in destroyAll it stops the window's other views going.
    // THE MUTANTS: call close() unguarded in the timer, in destroy, or in destroyAll.
    vi.useFakeTimers();
    try {
      const { host, views, tabs } = makeHost();
      host.create("b1", "", null, P);
      const hooks = views.get("b1")!.getHooks();
      hooks.openTab("https://example.com/a", false, closedPage(), false);
      expect(() => vi.advanceTimersByTime(UNCLAIMED_TAB_MS)).not.toThrow();
      hooks.openTab("https://example.com/b", true, closedPage(), false);
      host.claimTab(tabs[1]!.page, "b2");
      expect(() => host.destroy("b2")).not.toThrow();
      hooks.openTab("https://example.com/c", true, closedPage(), false);
      hooks.openTab("https://example.com/d", true, closedPage(), false);
      host.claimTab(tabs[3]!.page, "b3");
      expect(() => host.destroyAll()).not.toThrow();
      expect(alive(views.get("b1")!)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("closes no tab for a page whose view Realm had already closed", () => {
    // A window closing tears its views down too, and its tabs stay in the layout it saves. THE MUTANT:
    // close the tab of any page that goes, and quitting empties every pane of its pages.
    const { host, views, closedTabs } = makeHost();
    host.create("b1", "https://example.com", null, P);
    host.destroyAll();
    views.get("b1")!.getHooks().pageClosed();
    expect(closedTabs).toEqual([]);
  });

  it("closes no tab for a page that went as its window went", async () => {
    // The order that would empty the panes: a page's view goes with nothing asking, and its window is
    // gone by the time the close is due. THE MUTANTS: send the close at once, or without asking whether
    // the window is gone, and the closing window's layout loses the tab.
    let gone = false;
    const { host, views, closedTabs } = makeHost(2, { windowGone: () => gone });
    host.create("b1", "https://example.com", null, P);
    views.get("b1")!.getHooks().pageClosed();
    gone = true;
    await turn();
    expect(closedTabs).toEqual([]);
    expect(host.has("b1")).toBe(false);
  });

  it("tells whoever asks for the page next which tabs it opened, once, waiting for one still being made", async () => {
    // What an agent's next act or snapshot is told (browser-agent-host.ts): the click opened a tab
    // rather than doing nothing. THE MUTANT: never record the claim, and the agent hears nothing.
    const { host, views, tabs } = makeHost();
    host.create("b1", "", null, P);
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, livePage(), false);
    const told = host.takeOpenedTabs("b1", 1_000);
    host.claimTab(tabs[0]!.page, "b2");
    expect(await told).toEqual([{ browserId: "b2", url: "https://example.com/a" }]);
    expect(await host.takeOpenedTabs("b1", 0)).toEqual([]);
    expect(await host.takeOpenedTabs("b2", 0)).toEqual([]);
  });

  it("closes every page still waiting for a tab when the window goes", () => {
    // THE MUTANT: clear the waiting pages without closing them, and they run on with no window.
    const { host, views, tabs } = makeHost();
    host.create("b1", "", null, P);
    const unclaimed = livePage();
    const claimed = livePage();
    views.get("b1")!.getHooks().openTab("https://example.com/a", false, unclaimed, false);
    views.get("b1")!.getHooks().openTab("https://example.com/b", true, claimed, false);
    host.claimTab(tabs[1]!.page, "b2");
    host.destroyAll();
    expect(unclaimed.close).toHaveBeenCalled();
    expect(claimed.close).toHaveBeenCalled();
  });

  it("says which popups a view's page has open, and none for a view it does not have", () => {
    // What an agent's snapshot is told (browser-agent-host.ts). The mutant answering [] hides them.
    const { host, views } = makeHost();
    host.create("b1", "example.com", null, P);
    views.get("b1")!.nav.popups = ["https://accounts.google.com/o/oauth2/v2/auth"];
    expect(host.popupsOf("b1")).toEqual(["https://accounts.google.com/o/oauth2/v2/auth"]);
    expect(host.popupsOf("nope")).toEqual([]);
  });

  it("setBounds converts css px → DIP with the renderer's dpr and applies visibility", () => {
    const { host, views } = makeHost(2);
    host.create("b1", "", null, P);
    host.setBounds("b1", { x: 100, y: 50, width: 200, height: 100 }, 2, true); // dpr==scale → passthrough
    expect(views.get("b1")!.calls).toContain("bounds:100,50,200,100");
    expect(views.get("b1")!.calls).toContain("visible:true");
    host.setBounds("b1", { x: 100, y: 50, width: 200, height: 100 }, 3, false); // zoomed 1.5x
    expect(views.get("b1")!.calls).toContain("bounds:150,75,300,150");
    expect(views.get("b1")!.calls.at(-1)).toBe("visible:false");
  });

  it("never lets the native view paint outside its placeholder — the divider lives in that pixel", () => {
    /* A WebContentsView composites ABOVE the DOM unconditionally, so an edge that rounds OUTWARD
       covers whatever the renderer drew next door and cannot be drawn over in return. Next door is
       `.resize-handle`, the entire boundary between two panes.

       THE mutant: `Math.round` per edge, which is what this was. 1054.344 rounded to 1054 — a third
       of a pixel left of the pane, on top of the divider — and the reports were of dividers that
       vanish and come back when you nudge them, because nudging moves the edge to a fraction that
       rounds the other way. Three panes put edges on thirds and six on sixths, which is why even
       splits were where it bit. */
    const containment = (rect: { x: number; y: number; width: number; height: number }, dpr: number, scale: number) => {
      const b = toViewBounds(rect, dpr, scale);
      const k = dpr / scale;
      return { spillsNear: b.x < rect.x * k - 1e-9 || b.y < rect.y * k - 1e-9,
               spillsFar: b.x + b.width > (rect.x + rect.width) * k + 1e-9 || b.y + b.height > (rect.y + rect.height) * k + 1e-9 };
    };
    // The measured case, and a sweep of every fraction a split can produce (halves, thirds, sixths).
    for (const frac of [0, 1 / 6, 1 / 3, 0.344, 0.5, 2 / 3, 5 / 6, 0.999]) {
      for (const [dpr, scale] of [[1, 1], [2, 2], [3, 2], [2, 1]] as const) {
        const rect = { x: 1054 + frac, y: 40 + frac, width: 385 + frac, height: 300 + frac };
        const c = containment(rect, dpr, scale);
        expect(c.spillsNear, `near edge, frac ${frac} @${dpr}/${scale}`).toBe(false);
        expect(c.spillsFar, `far edge, frac ${frac} @${dpr}/${scale}`).toBe(false);
      }
    }
  });

  it("still fills the placeholder when it already sits on the pixel grid", () => {
    // Insetting must not cost a pixel in the ordinary case, or every browser pane grows a hairline
    // of pane ground down its edge. Whole numbers in, the same whole numbers out.
    expect(toViewBounds({ x: 100, y: 50, width: 200, height: 100 }, 2, 2)).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(toViewBounds({ x: 100, y: 50, width: 200, height: 100 }, 3, 2)).toEqual({ x: 150, y: 75, width: 300, height: 150 });
  });

  it("gives back an empty rect rather than a negative one when the layout is mid-flight", () => {
    // A collapsed or inverted placeholder must not reach setBounds as a negative size.
    expect(toViewBounds({ x: 10.7, y: 10.7, width: 0.2, height: 0.2 }, 1, 1)).toMatchObject({ width: 0, height: 0 });
    expect(toViewBounds({ x: 0, y: 0, width: -5, height: -5 }, 1, 1)).toMatchObject({ width: 0, height: 0 });
  });

  it("navAction routes back/forward/reload/stop; unknown ids are ignored", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    for (const a of ["back", "forward", "reload", "stop"] as const) host.navAction("b1", a);
    expect(views.get("b1")!.calls).toEqual(expect.arrayContaining(["back", "forward", "reload", "stop"]));
    expect(() => host.navAction("nope", "back")).not.toThrow();
  });

  it("destroy is final: the view is torn down and every later call is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    host.destroy("b1");
    expect(views.get("b1")!.calls).toContain("destroy");
    expect(host.has("b1")).toBe(false);
    host.navigate("b1", "example.com");
    host.setBounds("b1", { x: 0, y: 0, width: 1, height: 1 }, 1, true);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(0);
    host.destroy("b1"); // idempotent
    expect(views.get("b1")!.calls.filter((c) => c === "destroy")).toHaveLength(1);
  });

  it("destroyAll survives views the window already destroyed (the close-crash regression)", () => {
    // Electron destroys child views WITH the window before the "closed" listener fires; a handle that
    // throws "Object has been destroyed" on a second destroy is exactly what the real adapter guards.
    // The host-level contract: destroyAll never throws and still forgets every row.
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.create("b2", "https://b.example", null, P);
    views.get("b1")!.handle.destroy = () => { throw new TypeError("Object has been destroyed"); };
    expect(() => host.destroyAll()).not.toThrow();
    expect(host.has("b1")).toBe(false);
    expect(host.has("b2")).toBe(false);
  });

  it("state events carry the id of THEIR view, not the last-created one", () => {
    const { host, views, states } = makeHost();
    host.create("b1", "", null, P);
    host.create("b2", "", null, P);
    views.get("b1")!.nav.title = "Page one";
    views.get("b1")!.getHooks().emitState();
    const last = states.at(-1)!;
    expect(last.id).toBe("b1");
    expect(last.title).toBe("Page one");
  });
});

/**
 * Retention: what a pane unmounting means. Switching space or pane group swaps the whole rendered
 * tree, so unmount is not the user closing anything — the view has to outlive it.
 */
describe("BrowserPaneHost retention", () => {
  it("retain keeps the view alive and hides it — a space switch must not close the browser", () => {
    const { host, views } = makeHost();
    host.create("b1", "example.com", null, P);
    host.retain("b1");
    expect(views.get("b1")!.calls).not.toContain("destroy");
    expect(host.has("b1")).toBe(true);
    // Main hides it itself: the renderer's per-frame bounds sync, which normally carries the
    // visibility verdict, stopped with the pane.
    expect(views.get("b1")!.calls.at(-1)).toBe("visible:false");
  });

  it("returning to the space re-adopts the SAME view instead of reloading it", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "example.com", null, P);
    host.retain("b1");
    host.create("b1", "example.com", null, P); // the pane remounts in its space
    expect(factory).toHaveBeenCalledTimes(1);
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("load:"))).toHaveLength(1);
  });

  it("a re-adopted view leaves the off-screen budget", async () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    host.retain(ids[0]!);
    host.create(ids[0]!, "example.com", null, P); // the user came back to its space
    for (const id of ids.slice(1)) host.retain(id); // exactly the budget, so nothing is evicted
    await host.settled();
    for (const id of ids) expect(alive(views.get(id)!)).toBe(true);
  });

  it("past the off-screen budget the LEAST recently retained view is discarded: its renderer goes, its page waits", async () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    for (const id of ids) host.retain(id);
    await host.settled();
    expect(alive(views.get(ids[0]!)!)).toBe(false); // oldest off-screen page pays
    // …but comes back with its pane, rather than being forgotten as it used to be.
    expect(host.has(ids[0]!)).toBe(true);
    expect(host.isDiscarded(ids[0]!)).toBe(true);
    for (const id of ids.slice(1)) expect(alive(views.get(id)!)).toBe(true);
  });

  it("touch spares a background view an agent is still driving", async () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    for (const id of ids.slice(0, RETAINED_VIEW_LIMIT)) host.retain(id);
    host.touch(ids[0]!); // an agent op reached it while its space was off screen
    host.retain(ids[RETAINED_VIEW_LIMIT]!);
    await host.settled();
    expect(alive(views.get(ids[0]!)!)).toBe(true);
    expect(alive(views.get(ids[1]!)!)).toBe(false); // the next-oldest pays instead
  });

  it("touch never makes an on-screen view evictable", async () => {
    const { host, views } = makeHost();
    const ids = overBudget(host);
    host.touch(ids[0]!); // still mounted, never retained
    for (const id of ids.slice(1)) host.retain(id); // exactly the budget
    await host.settled();
    for (const id of ids) expect(alive(views.get(id)!)).toBe(true);
  });

  it("a page its guard spares keeps the budget over rather than going", async () => {
    // Media playing, or a form half filled in: the budget never takes it, as the idle sweep never does.
    const { host, views } = makeHost(2, { guard: async (id) => (id === "v0" ? "media" : null) });
    const ids = overBudget(host);
    for (const id of ids) host.retain(id);
    await host.settled();
    expect(alive(views.get("v0")!)).toBe(true);
    expect(alive(views.get(ids[1]!)!)).toBe(false);
  });

  it("keeps to Settings ▸ RAM: as many unmounted views as it says stay loaded, and none discarded at Never", async () => {
    // THE MUTANT: the old fixed budget of three, which discards a fourth page the person said to keep.
    let limit: number | null = 5;
    const views = new Map<string, ReturnType<typeof fakeView>>();
    const host = new BrowserPaneHost({
      createView: (id, hooks) => { const v = fakeView(); v.setHooks(hooks); views.set(id, v); return v.handle; },
      sendState: () => {}, scaleFactor: () => 2, retainedLimit: () => limit,
    });
    const ids = Array.from({ length: 6 }, (_, i) => `p${i}`);
    for (const id of ids) { host.create(id, `https://${id}.example`, null, P); host.retain(id); }
    await host.settled();
    expect(ids.filter((id) => host.isDiscarded(id))).toEqual(["p0"]);
    limit = null;
    for (const id of ["q0", "q1", "q2", "q3", "q4", "q5", "q6"]) { host.create(id, `https://${id}.example`, null, P); host.retain(id); }
    await host.settled();
    expect(["q0", "q1", "q2", "q3", "q4", "q5", "q6"].filter((id) => host.isDiscarded(id))).toEqual([]);
  });

  it("takes its number from Settings ▸ RAM, never below three, and none at Never", () => {
    // THE MUTANT: "kept loaded" alone. At 1 or 0, every page left behind by a space switch would go at
    // once, with no window at all — sooner than the idle sweep would ever have taken it.
    expect(retainedBudget({ keepHidden: 5, never: false })).toBe(5);
    expect(retainedBudget({ keepHidden: 1, never: false })).toBe(RETAINED_VIEW_LIMIT);
    expect(retainedBudget({ keepHidden: 0, never: false })).toBe(RETAINED_VIEW_LIMIT);
    expect(retainedBudget({ keepHidden: 5, never: true })).toBeNull();
    expect(RETAINED_VIEW_LIMIT).toBe(3);
  });

  it("retain on an unknown id is refused, not thrown", () => {
    const { host } = makeHost();
    expect(() => host.retain("nope")).not.toThrow();
    expect(() => host.touch("nope")).not.toThrow();
  });

  it("destroyAll still takes retained views — they must never outlive the window", () => {
    const { host, views } = makeHost();
    host.create("b1", "", null, P);
    host.retain("b1");
    host.destroyAll();
    expect(alive(views.get("b1")!)).toBe(false);
    expect(host.has("b1")).toBe(false);
  });
});

/**
 * Discarding a hidden view to free its renderer's memory (the resource manager's browser policy): it
 * keeps its page and scroll and comes back when shown. What must die: a view discarded while on screen,
 * while an agent drives it, while its page plays media or holds input; one that never comes back, comes
 * back in the wrong jar or the wrong place, or flashes white on the way.
 */
describe("BrowserPaneHost — discarding hidden views", () => {
  const MIN = 60_000;
  const R = { x: 10, y: 20, width: 400, height: 300 };
  function clocked(guard?: (id: string) => Promise<KeepReason | null>) {
    let t = 1_000_000;
    const env = makeHost(2, { now: () => t, ...(guard ? { guard } : {}) });
    const page = (id: string, url: string) => {
      env.host.create(id, url, null, P);
      const v = env.views.get(id)!;
      v.nav.url = normalizeAddress(url)!; v.nav.ready = true; v.nav.loading = false;
      env.host.setBounds(id, R, 2, true);
      return v;
    };
    const hide = (id: string) => env.host.setBounds(id, R, 2, false);
    return { ...env, page, hide, at: (m: number) => { t = 1_000_000 + m * MIN; } };
  }

  it("discards a view hidden past the window, keeping the most recently hidden ones", async () => {
    const { host, views, page, hide, at } = clocked();
    for (const id of ["a", "b", "c", "d"]) page(id, `https://${id}.example`);
    at(0); hide("a"); at(1); hide("b"); at(2); hide("c"); at(3); hide("d");
    at(25);
    const r = await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 2 });
    // d and c are the two most recently hidden; a and b have been hidden over twenty minutes.
    expect(r.discarded.sort()).toEqual(["a", "b"]);
    expect(r.kept).toEqual([{ id: "d", reason: "recent" }, { id: "c", reason: "recent" }]);
    expect(alive(views.get("a")!)).toBe(false);
    expect(host.has("a")).toBe(true);
  });

  it("does not count a pane behind a page overlay as hidden — Settings over the window hides every view", async () => {
    // THE MUTANT: the idle clock read off the view's own show flag, which a page overlay, a drag and
    // the mount settle all turn off. Settings ▸ RAM is such an overlay: its button would discard
    // every page that was on screen behind it.
    const { host, views, page, at } = clocked();
    page("behind", "https://behind.example");
    page("other-tab", "https://other.example");
    at(0);
    host.setBounds("behind", R, 2, false, true); // covered, still the pane showing
    host.setBounds("other-tab", R, 2, false, false); // its tab switched away
    expect(views.get("behind")!.calls.at(-1)).toBe("visible:false");
    expect(host.visibilityOf("behind")).toEqual({ visible: true, hiddenSince: null });
    at(60);
    expect((await host.sweep({ hiddenMs: 0, keepHidden: 0 })).discarded).toEqual(["other-tab"]);
    expect(host.isDiscarded("behind")).toBe(false);
    expect(await host.discard("behind")).toBe(false);
  });

  it("never discards a view on screen, or one hidden for less than the window", async () => {
    const { host, page, hide, at } = clocked();
    page("on", "https://on.example");
    page("brief", "https://brief.example");
    at(0); hide("brief");
    at(19);
    expect((await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 })).discarded).toEqual([]);
    // The button takes everything hidden — and still nothing on screen.
    expect((await host.sweep({ hiddenMs: 0, keepHidden: 0 })).discarded).toEqual(["brief"]);
    expect(host.isDiscarded("on")).toBe(false);
  });

  it("never discards one an agent drove within the window, however long it has been hidden", async () => {
    // THE MUTANT: reading only how long the pane has been hidden. An agent working in a background
    // browser has no pane on screen at all.
    const { host, page, hide, at } = clocked();
    page("b", "https://b.example");
    at(0); hide("b");
    at(30); host.touch("b");
    at(45);
    expect(await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 })).toEqual({ discarded: [], kept: [{ id: "b", reason: "agent" }] });
    // The button has no window, but an agent's last op still buys a few minutes' grace.
    at(46); host.touch("b");
    at(48);
    expect(await host.sweep({ hiddenMs: 0, keepHidden: 0 })).toEqual({ discarded: [], kept: [{ id: "b", reason: "agent" }] });
    at(46 + 21);
    expect((await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 })).discarded).toEqual(["b"]);
    expect(AGENT_GRACE_MS).toBeLessThan(20 * MIN);
  });

  it("never discards one whose page plays media or holds input, and says which", async () => {
    const reasons: Record<string, KeepReason> = { video: "media", draft: "form" };
    const { host, page, hide, at } = clocked(async (id) => reasons[id] ?? null);
    for (const id of ["video", "draft", "plain"]) { page(id, `https://${id}.example`); hide(id); }
    at(60);
    const r = await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    expect(r.discarded).toEqual(["plain"]);
    expect(r.kept).toEqual(expect.arrayContaining([{ id: "video", reason: "media" }, { id: "draft", reason: "form" }]));
  });

  it("lets an agent's step wait for a revived page to load rather than read the blank it boots on", async () => {
    const { host, views, page, hide, at } = clocked();
    page("b", "https://b.example/inbox");
    hide("b");
    at(60);
    await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    let settled = false;
    const waiting = host.revivedPage("b", { pollMs: 5 }).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    // Brought back, loading — and the step still waits.
    expect(views.get("b")!.calls).toContain("load:https://b.example/inbox");
    expect(settled).toBe(false);
    views.get("b")!.nav.ready = true;
    await waiting;
    // A live page that never left, or one that will not load, waits no longer than it must.
    page("c", "https://c.example");
    await host.revivedPage("c");
    hide("c");
    at(200);
    await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    const failing = host.revivedPage("c", { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 15));
    views.get("c")!.nav.error = { code: -105, name: "ERR_NAME_NOT_RESOLVED", url: "https://c.example/" };
    await failing;
  });

  it("leaves a view that came back on screen while its scroll was being read", async () => {
    const { host, views, page, hide, at } = clocked();
    const v = page("b", "https://b.example");
    hide("b");
    at(60);
    let release!: (s: { x: number; y: number }) => void;
    v.handle.readScroll = () => new Promise((r) => { release = r; });
    const sweeping = host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    await new Promise((r) => setTimeout(r, 0));
    host.setBounds("b", R, 2, true); // the person switched back to its tab
    release({ x: 0, y: 900 });
    expect((await sweeping).discarded).toEqual([]);
    expect(alive(views.get("b")!)).toBe(true);
  });

  it("comes back when shown: in its own jar, on its page, scrolled where it was, hidden until it has painted", async () => {
    const { host, views, states, factory, page, hide, at } = clocked();
    const first = page("b", "https://b.example/long");
    first.nav.scroll = { x: 0, y: 1234 };
    hide("b");
    at(60);
    await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    const sent = states.length;
    // Asked to stay hidden, it stays given up — and nothing was sent to the pane about it.
    host.setBounds("b", R, 2, false);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(states.length).toBe(sent);
    host.setBounds("b", R, 2, true);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]![2]).toBe(P);
    const back = views.get("b")!;
    expect(back.calls).toContain("scrollAfterLoad:0,1234");
    expect(back.calls).toContain("load:https://b.example/long");
    // Not painted yet: the pane's own ground shows, never a blank white view.
    expect(back.calls.filter((c) => c.startsWith("visible:"))).toEqual(["visible:false"]);
    back.nav.ready = true;
    host.setBounds("b", R, 2, true);
    expect(back.calls.at(-1)).toBe("visible:true");
  });

  it("comes back when its pane remounts, on the page it was on rather than the row's", async () => {
    const { host, views, page, hide, at } = clocked();
    const v = page("b", "https://b.example/a");
    v.nav.url = "https://b.example/later"; // navigated since the row was saved
    hide("b");
    host.retain("b");
    at(60);
    await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    host.create("b", "https://b.example/a", null, P);
    expect(views.get("b")!.calls).toContain("load:https://b.example/later");
  });

  it("comes back for anything that needs its page: a reload, a find, a navigation, an agent's attach", async () => {
    for (const use of [
      (h: BrowserPaneHost) => h.navAction("b", "reload"),
      (h: BrowserPaneHost) => h.find("b", "word", "start"),
      (h: BrowserPaneHost) => h.navigate("b", "https://b.example/next"),
      (h: BrowserPaneHost) => h.live("b"),
    ]) {
      const { host, factory, page, hide, at } = clocked();
      page("b", "https://b.example");
      hide("b");
      at(60);
      await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
      use(host);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(host.isDiscarded("b")).toBe(false);
    }
  });

  it("does not bring a page back past a fence put up while it was away", async () => {
    const { host, views, page, hide, at } = clocked();
    page("b", "https://evil.example");
    hide("b");
    at(60);
    await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    host.setAllowlist("b", ["https://good.example"]);
    host.setBounds("b", R, 2, true);
    expect(views.get("b")!.calls.some((c) => c.startsWith("load:"))).toBe(false);
  });

  it("is forgotten when the browser is closed, or its profile's jar goes", async () => {
    const { host, page, hide, at } = clocked();
    page("b", "https://b.example");
    page("w", "https://w.example");
    hide("b"); hide("w");
    at(60);
    await host.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    host.destroy("b");
    expect(host.has("b")).toBe(false);
    host.destroyPartition(P);
    expect(host.has("w")).toBe(false);
  });
});

/**
 * The hidden views of every window, counted as one, and kept loaded for a while rather than forever.
 * What must die: the "most recently hidden" exemption counted per window (eleven windows, thirty-three
 * unthrottled renderers), that exemption or a slow page's "loading" lasting for days, and any of it
 * reaching a page on screen, one playing audio or one an agent is driving.
 */
describe("HiddenViews — every window's hidden panes, with an age limit", () => {
  const MIN = 60_000;
  const R = { x: 10, y: 20, width: 400, height: 300 };
  function windows(guard?: (id: string) => Promise<KeepReason | null>, limit = 3) {
    let t = 1_000_000;
    const now = () => t;
    const pool = new HiddenViews({ now, limit: () => limit });
    const open = () => {
      const env = makeHost(2, { now, pool, ...(guard ? { guard } : {}) });
      const page = (id: string) => {
        env.host.create(id, `https://${id}.example`, null, P);
        const v = env.views.get(id)!;
        v.nav.url = `https://${id}.example/`; v.nav.ready = true; v.nav.loading = false;
        env.host.setBounds(id, R, 2, true);
        return v;
      };
      return { ...env, page, hide: (id: string) => env.host.setBounds(id, R, 2, false) };
    };
    return { pool, open, at: (ms: number) => { t = 1_000_000 + ms; } };
  }

  it("keeps a recently hidden pane only until the age limit, then discards it", async () => {
    // THE MUTANT: the "recent" exemption ahead of any age check, which kept a pane hidden for three days.
    const { pool, open, at } = windows();
    const w = open();
    w.page("a");
    at(0); w.hide("a");
    at(HIDDEN_KEEP_MAX_MS - MIN);
    expect(await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 3 })).toEqual({ discarded: [], kept: [{ id: "a", reason: "recent" }] });
    at(HIDDEN_KEEP_MAX_MS);
    expect((await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 3 })).discarded).toEqual(["a"]);
    expect(alive(w.views.get("a")!)).toBe(false);
    expect(w.host.isDiscarded("a")).toBe(true);
    expect(HIDDEN_KEEP_MAX_MS).toBe(2 * 60 * MIN);
  });

  it("keeps an unloaded window's panes out of the budget for unmounted ones, so they take no other window's", async () => {
    // THE MUTANT: the views on screen in a window that unloads retained, five past a budget of three,
    // and the other window's background pages discarded for them.
    const { pool, open, at } = windows();
    const one = open(), two = open();
    for (const id of ["a1", "a2", "a3"]) { one.page(id); one.host.retain(id); }
    for (const id of ["b1", "b2"]) two.page(id);
    at(60 * MIN);
    two.host.parkShown();
    await pool.settled();
    for (const id of ["a1", "a2", "a3"]) expect(alive(one.views.get(id)!)).toBe(true);
    for (const id of ["b1", "b2"]) {
      expect(alive(two.views.get(id)!)).toBe(true);
      expect(two.views.get(id)!.calls.at(-1)).toBe("visible:false");
    }
    // Its page back, its panes adopt the same views.
    two.host.create("b1", "https://b1.example", null, P);
    expect(alive(two.views.get("b1")!)).toBe(true);
  });

  it("counts the most recently hidden across every window, not in each", async () => {
    // THE MUTANT: each window's sweep keeping its own three.
    const { pool, open, at } = windows();
    const one = open(), two = open();
    for (const id of ["a1", "a2", "a3", "a4"]) one.page(id);
    for (const id of ["b1", "b2", "b3", "b4"]) two.page(id);
    // The second window's panes were all hidden after the first's: counted per window, b4, b3 and b2
    // would stay as well.
    for (const [i, [w, id]] of ([[one, "a1"], [one, "a2"], [one, "a3"], [one, "a4"], [two, "b1"], [two, "b2"], [two, "b3"], [two, "b4"]] as const).entries()) {
      at(i * MIN); w.hide(id);
    }
    at(30 * MIN);
    const r = await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 3 });
    expect(r.kept).toEqual([{ id: "b4", reason: "recent" }, { id: "b3", reason: "recent" }, { id: "b2", reason: "recent" }]);
    expect(r.discarded.sort()).toEqual(["a1", "a2", "a3", "a4", "b1"]);
  });

  it("holds the off-screen budget across every window, oldest first", async () => {
    // THE MUTANT: a budget per window, so two windows keep six unmounted pages between them.
    const { pool, open, at } = windows();
    const one = open(), two = open();
    for (const id of ["a1", "a2"]) one.page(id);
    for (const id of ["b1", "b2"]) two.page(id);
    at(0); one.host.retain("a1");
    at(MIN); two.host.retain("b1");
    at(2 * MIN); one.host.retain("a2");
    at(3 * MIN); two.host.retain("b2");
    await pool.settled();
    expect(["a1", "a2", "b1", "b2"].filter((id) => one.host.isDiscarded(id) || two.host.isDiscarded(id))).toEqual(["a1"]);
  });

  it("keeps a page its guard calls loading only until the age limit", async () => {
    // THE MUTANT: "loading" sparing a page forever — a frame too slow to answer is read as loading,
    // so under load nothing was ever discarded.
    const { pool, open, at } = windows(async () => "loading");
    const w = open();
    w.page("slow");
    at(0); w.hide("slow");
    at(30 * MIN);
    expect(await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 })).toEqual({ discarded: [], kept: [{ id: "slow", reason: "loading" }] });
    at(HIDDEN_KEEP_MAX_MS);
    expect((await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 })).discarded).toEqual(["slow"]);
  });

  it("lets the off-screen budget take a slow page once it is past the age limit", async () => {
    const { pool, open, at } = windows(async (id) => (id === "slow" ? "loading" : null), 1);
    const w = open();
    w.page("slow"); w.page("next");
    at(0); w.host.retain("slow");
    at(MIN); w.host.retain("next");
    await pool.settled();
    expect(w.host.isDiscarded("slow")).toBe(false);
    at(HIDDEN_KEEP_MAX_MS + MIN); w.page("last"); w.host.retain("last");
    await pool.settled();
    expect(w.host.isDiscarded("slow")).toBe(true);
  });

  it("never takes a pane on screen, one playing audio or one an agent is driving, however old", async () => {
    const { pool, open, at } = windows(async (id) => (id === "audio" ? "media" : null), 1);
    const one = open(), two = open();
    one.page("shown"); one.page("audio"); two.page("driven"); two.page("plain"); two.page("other");
    at(0); one.host.retain("audio"); two.host.retain("driven");
    at(3 * 24 * 60 * MIN);
    two.host.touch("driven"); // an agent's op, just now
    two.host.retain("plain"); two.host.retain("other");
    await pool.settled();
    expect((await pool.sweep({ hiddenMs: 0, keepHidden: 0 })).kept).toEqual(expect.arrayContaining([{ id: "audio", reason: "media" }, { id: "driven", reason: "agent" }]));
    expect(one.host.isDiscarded("shown")).toBe(false);
    expect(one.host.isDiscarded("audio")).toBe(false);
    expect(two.host.isDiscarded("driven")).toBe(false);
    expect(two.host.isDiscarded("plain")).toBe(true);
  });

  it("brings an aged-out pane back on its own page when it is shown again", async () => {
    const { pool, open, at } = windows();
    open().page("other");
    const w = open();
    const v = w.page("b");
    v.nav.url = "https://b.example/inbox";
    at(0); w.hide("b");
    at(HIDDEN_KEEP_MAX_MS);
    await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 3 });
    expect(w.host.isDiscarded("b")).toBe(true);
    w.host.setBounds("b", R, 2, true);
    expect(w.factory).toHaveBeenCalledTimes(2);
    expect(w.views.get("b")!.calls).toContain("load:https://b.example/inbox");
    expect(w.host.isDiscarded("b")).toBe(false);
  });

  it("forgets a closed window's panes", async () => {
    // THE MUTANT: `destroyAll` not leaving the pool — the closed window's views are already gone, so
    // only the pool's own list of hosts can tell.
    const { pool, open, at } = windows();
    const gone = open(), kept = open();
    gone.page("g"); kept.page("k");
    at(0); gone.hide("g"); at(MIN); kept.hide("k");
    gone.host.destroyAll();
    expect([...(pool as unknown as { hosts: Set<BrowserPaneHost> }).hosts]).toEqual([kept.host]);
    at(30 * MIN);
    expect(await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 3 })).toEqual({ discarded: [], kept: [{ id: "k", reason: "recent" }] });
  });

  it("spares a pane an agent drives while the sweep awaits its guard", async () => {
    // THE MUTANT: the agent's last op read before the guard's await (up to a second a frame) and not
    // again — a browser_act landing in that gap lost its page.
    let w!: ReturnType<ReturnType<typeof windows>["open"]>;
    const { pool, open, at } = windows(async (id) => { w.host.touch(id); return null; });
    w = open();
    w.page("a");
    at(0); w.hide("a");
    at(30 * MIN);
    expect((await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 })).discarded).toEqual([]);
    expect(w.host.isDiscarded("a")).toBe(false);
  });

  it("spares a pane an agent drives while the off-screen budget awaits its guard", async () => {
    let w!: ReturnType<ReturnType<typeof windows>["open"]>;
    const { pool, open, at } = windows(async (id) => { if (id === "a1") w.host.touch(id); return null; }, 1);
    w = open();
    w.page("a1"); w.page("a2");
    at(0); w.host.retain("a1");
    at(MIN); w.host.retain("a2");
    await pool.settled();
    expect(w.host.isDiscarded("a1")).toBe(false);
    expect(w.host.isDiscarded("a2")).toBe(true);
  });

  it("orders the off-screen budget by one stamp across windows, whichever window retained first", async () => {
    // THE MUTANT: a stamp per window — b1 and a1 tie, and the first window's a1 goes instead of b1.
    const { pool, open, at } = windows(undefined, 3);
    const one = open(), two = open();
    for (const id of ["a1", "a2"]) one.page(id);
    for (const id of ["b1", "b2"]) two.page(id);
    at(0); two.host.retain("b1");
    at(MIN); one.host.retain("a1");
    at(2 * MIN); one.host.retain("a2");
    at(3 * MIN); two.host.retain("b2");
    await pool.settled();
    expect(["a1", "a2", "b1", "b2"].filter((id) => one.host.isDiscarded(id) || two.host.isDiscarded(id))).toEqual(["b1"]);
  });

  it("lets only \"loading\" lapse at the age limit — session, DevTools, input and a popup still keep a page", async () => {
    // THE MUTANT: the age limit applied to every guard reason, not just a slow frame's "loading".
    const reasons = { session: "session", devtools: "devtools", form: "form", popup: "popup" } as const;
    const { pool, open, at } = windows(async (id) => reasons[id as keyof typeof reasons] ?? null, 1);
    const w = open();
    for (const id of Object.keys(reasons)) w.page(id);
    at(0); for (const id of Object.keys(reasons)) w.host.retain(id);
    at(3 * HIDDEN_KEEP_MAX_MS);
    w.page("next"); w.host.retain("next");
    await pool.settled();
    const r = await pool.sweep({ hiddenMs: 20 * MIN, keepHidden: 0 });
    expect(r.kept).toEqual(expect.arrayContaining(Object.entries(reasons).map(([id, reason]) => ({ id, reason }))));
    for (const id of Object.keys(reasons)) expect(w.host.isDiscarded(id)).toBe(false);
    expect(w.host.isDiscarded("next")).toBe(true);
  });
});

/**
 * Plan 27 Phase 2: a view lives in its profile's cookie jar. What must die here: a view made in the
 * wrong jar, and a RETAINED view re-adopted into a pane that now wants another jar — its page would
 * show the second profile the first one's sign-ins.
 */
describe("BrowserPaneHost — a partition per profile", () => {
  const WORK = "persist:browser-pWork";

  it("makes the view in the partition it is asked for, and says which", () => {
    const { host, factory } = makeHost();
    host.create("b1", "example.com", null, WORK);
    expect(factory.mock.calls[0]![2]).toBe(WORK);
    expect(host.partitionOf("b1")).toBe(WORK);
    expect(host.partitionOf("nope")).toBeNull();
  });

  it("a retained view asked back for ANOTHER profile's jar is destroyed and made again there", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "https://mail.example", null, P);
    const first = views.get("b1")!;
    host.retain("b1");
    // The space moved to Work while the pane was off screen; the pane comes back wanting Work's jar.
    host.create("b1", "https://mail.example", null, WORK);
    expect(alive(first)).toBe(false);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]![2]).toBe(WORK);
    expect(host.partitionOf("b1")).toBe(WORK);
    expect(views.get("b1")!.calls).toContain("load:https://mail.example");
  });

  it("the SAME jar still adopts the live view — no reload, which is what retaining is for", () => {
    const { host, views, factory } = makeHost();
    host.create("b1", "https://mail.example", null, WORK);
    host.retain("b1");
    host.create("b1", "https://mail.example", null, WORK);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(alive(views.get("b1")!)).toBe(true);
  });

  it("destroyPartition takes every view in one jar, retained or showing, and leaves the others", () => {
    const { host, views } = makeHost();
    host.create("w1", "", null, WORK);
    host.create("w2", "", null, WORK);
    host.retain("w2");
    host.create("p1", "", null, P);
    host.destroyPartition(WORK);
    expect(alive(views.get("w1")!)).toBe(false);
    expect(alive(views.get("w2")!)).toBe(false);
    expect(alive(views.get("p1")!)).toBe(true);
    expect(host.has("w2")).toBe(false);
  });
});

/**
 * The pane's user agent. What must die here: the Electron token surviving into a request (sites read
 * it and quietly serve a different page); the full Chrome build number surviving (real Chrome froze
 * those at zero, so keeping them is its own tell); and — the mutant that would be tempting — the
 * MAJOR being rewritten to something newer than the engine, which trades a nag today for a feature
 * the page may then use and the renderer cannot do.
 */
describe("browserUserAgent", () => {
  const E45 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36";

  it("takes the Electron token out and freezes the Chrome build, leaving a plain Chrome UA", () => {
    expect(browserUserAgent(E45)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
  });

  it("is idempotent — it is applied at the session AND at each view, and must not compound", () => {
    const once = browserUserAgent(E45);
    expect(browserUserAgent(once)).toBe(once);
    expect(browserUserAgent(browserUserAgent(once))).toBe(once);
  });

  it("tracks whatever Chromium ships, rather than a version anyone has to remember to update", () => {
    const E44 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.4.3 Safari/537.36";
    expect(browserUserAgent(E44)).toContain("Chrome/152.0.0.0");
    expect(browserUserAgent(E44)).not.toContain("Electron");
  });

  it("hands back anything it does not recognise, rather than rewriting a string blind", () => {
    // Fail closed on shape: a UA with no Chrome token is not one this function has an opinion about,
    // and half-rewriting it would produce something no browser has ever sent.
    expect(browserUserAgent("curl/8.7.1")).toBe("curl/8.7.1");
    expect(browserUserAgent("")).toBe("");
  });

});

/* ------------------------------ the ⋯ menu's view calls (Plan 26 W7b) ------------------------------ */

describe("find in page", () => {
  it("a new query starts a session; Next and Previous step through it without restarting", () => {
    /* THE mutant is Electron's own naming: `findNext: true` means "begin a NEW search". Passed on every
       press, the search restarts at the first match and the Next button never moves. */
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    host.find("b1", "agent", "start");
    host.find("b1", "agent", "next");
    host.find("b1", "agent", "previous");
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("find:"))).toEqual([
      "find:agent:forward:new", "find:agent:forward:step", "find:agent:backward:step",
    ]);
  });

  it("an emptied field ends the find instead of searching for nothing", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    host.find("b1", "", "start");
    host.stopFind("b1");
    const calls = views.get("b1")!.calls;
    expect(calls.filter((c) => c.startsWith("find:"))).toEqual([]);
    expect(calls.filter((c) => c === "stop-find")).toHaveLength(2);
    expect(() => host.find("nope", "x", "start")).not.toThrow();
  });

  it("a view's result and its ⌘F reach the pane they came from, by id", () => {
    const { host, views, found, findRequests } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.create("b2", "https://b.example", null, P);
    views.get("b2")!.getHooks().found({ activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    views.get("b1")!.getHooks().findShortcut();
    expect(found).toEqual([{ id: "b2", activeMatchOrdinal: 2, matches: 5, finalUpdate: true }]);
    expect(findRequests).toEqual(["b1"]);
  });
});

describe("isFindShortcut", () => {
  const key = (over: Partial<Parameters<typeof isFindShortcut>[0]> = {}) =>
    ({ type: "keyDown", key: "f", meta: true, control: false, alt: false, shift: false, ...over });

  it("is ⌘F on a Mac, on key-down, and nothing else", () => {
    expect(isFindShortcut(key(), "darwin")).toBe(true);
    expect(isFindShortcut(key({ key: "F" }), "darwin")).toBe(true);
    expect(isFindShortcut(key({ type: "keyUp" }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ key: "g" }), "darwin")).toBe(false);
    // ⌘⇧F is pane focus. Taking it from the page here would break the other shortcut.
    expect(isFindShortcut(key({ shift: true }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ alt: true }), "darwin")).toBe(false);
  });

  it("leaves ⌃F to the text cursor on a Mac, where it moves forward a character", () => {
    expect(isFindShortcut(key({ meta: false, control: true }), "darwin")).toBe(false);
    expect(isFindShortcut(key({ meta: false, control: true }), "linux")).toBe(true);
  });
});

describe("zoom", () => {
  it("steps along Chrome's ladder and answers the level the view is at afterwards", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    expect(host.zoom("b1", null)).toBe(1); // a read changes nothing
    expect(views.get("b1")!.calls.filter((c) => c.startsWith("zoom:"))).toEqual([]);
    expect(host.zoom("b1", "in")).toBe(1.1);
    expect(host.zoom("b1", "in")).toBe(1.25);
    expect(host.zoom("b1", "out")).toBe(1.1);
    expect(host.zoom("b1", "reset")).toBe(1);
    expect(host.zoom("nope", "in")).toBe(1);
  });

  it("reads back what Chromium actually did rather than what was asked", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://example.com", null, P);
    // A view that refuses the level (a crashed page, say) keeps its old one, and the menu must say so.
    views.get("b1")!.handle.setZoomFactor = () => {};
    expect(host.zoom("b1", "in")).toBe(1);
  });

  it("goes to the nearest rung from a level the View menu's own zoom left between them", () => {
    // ⌘+ with the page focused is Electron's zoom role, which steps half a zoom level: 1.0954…
    expect(nextZoomFactor(1.0954, "in")).toBe(1.1);
    expect(nextZoomFactor(1.0954, "out")).toBe(1);
    expect(nextZoomFactor(1.1, "in")).toBe(1.25);
    // The ends hold rather than run off the ladder.
    expect(nextZoomFactor(ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!, "in")).toBe(5);
    expect(nextZoomFactor(ZOOM_FACTORS[0]!, "out")).toBe(0.25);
    expect(nextZoomFactor(Number.NaN, "in")).toBe(1);
    expect(zoomPercent(1.1)).toBe(110);
    expect(zoomPercent(0.33)).toBe(33);
  });
});

describe("print", () => {
  it("reaches the view it was asked for, and an unknown one is a no-op", () => {
    const { host, views } = makeHost();
    host.create("b1", "https://a.example", null, P);
    host.create("b2", "https://b.example", null, P);
    host.print("b2");
    expect(views.get("b2")!.calls).toContain("print");
    expect(views.get("b1")!.calls).not.toContain("print");
    expect(() => host.print("nope")).not.toThrow();
  });
});

/* ------------------------------ Device size (Plan 26 W7e) ------------------------------ */

const preset = (id: string) => DEVICE_PRESETS.find((d) => d.id === id)!;

describe("deviceFit", () => {

  it("a desktop in a narrow pane is scaled down to the pane's width, and told the height that fills it", () => {
    /* THE mutant: no scale. A 1440-wide page in a 600-wide view is cropped to its left two-fifths, and
       the box is not a preview of anything. */
    const fit = deviceFit({ x: 900, y: 80, width: 600, height: 840 }, preset("desktop"))!;
    expect(fit.view).toEqual({ x: 900, y: 80, width: 600, height: 840 });
    expect(fit.metrics).toMatchObject({ width: 1440, mobile: false });
    expect(fit.metrics.scale).toBeCloseTo(600 / 1440, 6);
    expect(fit.metrics.height).toBe(Math.round(840 / (600 / 1440)));
  });

  it("never draws outside the pane it was given, and has nothing to fit in an empty one", () => {
    for (const p of DEVICE_PRESETS) for (const width of [200, 389, 390, 391, 820, 1439, 1441, 2000]) {
      const fit = deviceFit({ x: 10, y: 20, width, height: 500 }, p)!;
      expect(fit.view.x).toBeGreaterThanOrEqual(10);
      expect(fit.view.x + fit.view.width).toBeLessThanOrEqual(10 + width);
    }
    expect(deviceFit({ x: 0, y: 0, width: 0, height: 500 }, preset("phone"))).toBeNull();
  });
});

describe("BrowserPaneHost — device size", () => {
  const setup = () => {
    const h = makeHost(1);
    h.host.create("b1", "https://example.com", null, P);
    h.host.setBounds("b1", { x: 900, y: 80, width: 600, height: 840 }, 1, true);
    return h;
  };
  const lastBounds = (calls: string[]) => calls.filter((c) => c.startsWith("bounds:")).at(-1);

  it("a preset narrows the view to the device's box and emulates it; Fit the pane undoes both", () => {
    const { host, views, emulations, states } = setup();
    host.setDevice("b1", "phone");
    expect(lastBounds(views.get("b1")!.calls)).toBe("bounds:1005,80,390,840");
    expect(emulations.at(-1)).toEqual({ id: "b1", metrics: { width: 390, height: 840, deviceScaleFactor: 0, mobile: true, scale: 1 } });
    expect(states.at(-1)!.device).toBe("phone");
    host.setDevice("b1", null);
    expect(lastBounds(views.get("b1")!.calls)).toBe("bounds:900,80,600,840");
    expect(emulations.at(-1)).toEqual({ id: "b1", metrics: null });
    expect(states.at(-1)!.device).toBeNull();
  });

  it("the box follows the pane as it resizes, and a resize that changes nothing sends nothing", () => {
    const { host, views, emulations } = setup();
    host.setDevice("b1", "phone");
    const sent = emulations.length;
    host.setBounds("b1", { x: 900, y: 80, width: 600, height: 840 }, 1, true);
    expect(emulations).toHaveLength(sent);
    host.setBounds("b1", { x: 700, y: 80, width: 800, height: 700 }, 1, true);
    expect(lastBounds(views.get("b1")!.calls)).toBe("bounds:905,80,390,700");
    expect(emulations.at(-1)!.metrics).toMatchObject({ width: 390, height: 700 });
  });

  it("a view never given a device never emulates, and an unknown preset is the pane", () => {
    const { host, emulations } = setup();
    host.setBounds("b1", { x: 900, y: 80, width: 500, height: 840 }, 1, true);
    expect(emulations).toEqual([]);
    host.setDevice("b1", "watch" as never);
    expect(host.deviceOf("b1")).toBeNull();
    expect(emulations).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------------
 * A page's icon: which of its offers, what the bytes are, and the one request main makes for it.
 * ------------------------------------------------------------------------------------------------ */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
const SVG = Buffer.from(`<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle r="8"/></svg>`);
const HTML_404 = Buffer.from("<!doctype html><html><head><title>Not found</title></head><body><svg></svg></body></html>");

describe("the state a pane's chrome is drawn from", () => {
  it("carries the page's icon, so the tab can draw it", () => {
    const { host, views, states } = makeHost();
    host.create("b1", "https://www.google.com/search?q=hi", null, P);
    const v = views.get("b1")!;
    v.nav.favicon = `data:image/x-icon;base64,${ICO.toString("base64")}`;
    v.getHooks().emitState();
    expect(states.at(-1)!.favicon).toBe(v.nav.favicon);
  });

  it("carries whether the page failed and whether it has anything to show, so the pane can hide the view", () => {
    const { host, views, states } = makeHost();
    host.create("b1", "http://localhost:3000", null, P);
    expect(states.at(-1)).toMatchObject({ error: null, ready: false });
    const v = views.get("b1")!;
    v.nav.error = { code: -102, name: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" };
    v.getHooks().emitState();
    expect(states.at(-1)).toMatchObject({ error: v.nav.error, ready: false });
    // …and the agent's side reads the same record, from the host, for the view it names.
    expect(host.loadErrorOf("b1")).toEqual(v.nav.error);
    expect(host.loadErrorOf("nope")).toBeNull();
  });
});

describe("PageLoad", () => {
  const REFUSED = { code: -102, name: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" };

  it("is an error page when Chromium commits one, with the address that was asked for", () => {
    const load = new PageLoad();
    load.failed(REFUSED.code, REFUSED.name, REFUSED.url);
    expect(load.error).toEqual(REFUSED);
    expect(load.ready).toBe(false);
  });

  it("never treats a stopped load as a failure", () => {
    /* THE mutant: drop the ERR_ABORTED guard. A page stopped mid-load — by the user, or by a
       navigation that replaced it — would come up as an error page over a page that is fine. */
    const load = new PageLoad();
    load.committed("https://example.com/");
    load.settled("https://example.com/");
    load.failed(-3, "", "https://example.com/");
    expect(load.error).toBeNull();
    expect(load.ready).toBe(true);
  });

  it("is ready once a document of its own is far enough along — not the about:blank it boots on, not an error page", () => {
    const load = new PageLoad();
    load.committed("about:blank");
    load.settled("about:blank");
    expect(load.ready).toBe(false);
    // An error page reaches DOMContentLoaded too (measured), and it is not a page to show.
    load.failed(REFUSED.code, REFUSED.name, REFUSED.url);
    load.settled(REFUSED.url);
    expect(load.ready).toBe(false);
    // The retry that worked: committed, then far enough along.
    load.committed("http://localhost:3000/");
    expect(load.error).toBeNull();
    expect(load.ready).toBe(false);
    load.settled("http://localhost:3000/");
    expect(load.ready).toBe(true);
  });

  it("stays ready from one good page to the next, and only an error page takes it back", () => {
    /* From page to page Chromium keeps the old one on screen until the new one paints, so hiding the
       view at the commit would blink the pane's ground between every two pages. */
    const load = new PageLoad();
    load.committed("https://a.example/");
    load.settled("https://a.example/");
    load.committed("https://b.example/");
    expect(load.ready).toBe(true);
    load.failed(-105, "ERR_NAME_NOT_RESOLVED", "https://c.example/");
    expect(load.ready).toBe(false);
  });
});

describe("shownPage", () => {
  it("names Realm's about:blank bootstrap after nothing: the address asked for, and no title", () => {
    // THE MUTANT: let the bootstrap's own title through. A restored tab was renamed "about:blank"
    // while its page was on the way — and kept that name when the page never came.
    expect(shownPage({ url: "about:blank", title: "about:blank" }, "https://example.com/")).toEqual({ url: "https://example.com/", title: "" });
    expect(shownPage({ url: "", title: "" }, null)).toEqual({ url: "", title: "" });
  });

  it("is the page's own address and title once it has committed", () => {
    expect(shownPage({ url: "https://example.com/", title: "Example Domain" }, "https://example.com/")).toEqual({ url: "https://example.com/", title: "Example Domain" });
  });
});

describe("rankFavicons", () => {
  it("puts an SVG first, then the smallest icon still sharp at 2x, then an unsized one, then a small one", () => {
    // Electron's own order (it hands over a sorted set): what a RealFaviconGenerator page offers.
    const offered = ["https://a.example/favicon-16x16.png", "https://a.example/favicon-192x192.png", "https://a.example/favicon-32x32.png", "https://a.example/favicon.ico"];
    // THE mutant: take the first. That is the 16px one, a blur in a Retina tab.
    expect(rankFavicons(offered)).toEqual(["https://a.example/favicon-32x32.png", "https://a.example/favicon-192x192.png", "https://a.example/favicon.ico", "https://a.example/favicon-16x16.png"]);
    expect(rankFavicons(["https://a.example/favicon.ico", "https://a.example/icon.svg?v=2"])[0]).toBe("https://a.example/icon.svg?v=2");
  });

  it("keeps only addresses an icon can come from — never a script, a file, or a credential", () => {
    expect(rankFavicons([
      "javascript:alert(1)", "file:///etc/passwd", "chrome://favicon/x", "https://me:pw@a.example/f.ico",
      `https://a.example/${"x".repeat(3_000)}.ico`, "data:text/html,<b>hi</b>",
      "https://a.example/favicon.ico", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    ])).toEqual(["data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "https://a.example/favicon.ico"]);
  });
});

describe("sniffImage", () => {
  it("knows a picture by its own bytes, whatever the server called it", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(ICO)).toBe("image/x-icon");
    expect(sniffImage(Buffer.from("GIF89a\x01\x00"))).toBe("image/gif");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffImage(SVG)).toBe("image/svg+xml");
  });

  it("refuses a page that answered /favicon.ico with its HTML — even one with an <svg> in it", () => {
    // THE mutant: trust the extension, or look for "<svg" anywhere. A soft 404 says 200 and text/html.
    expect(sniffImage(HTML_404)).toBeNull();
    expect(sniffImage(Buffer.from("not found"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("faviconDataUrl and dataUrlBytes", () => {
  it("turns an icon's bytes into the data: URL the row keeps, typed by what they are", () => {
    const url = faviconDataUrl(ICO)!;
    expect(url).toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
    expect(isFaviconDataUrl(url)).toBe(true);
    expect(faviconDataUrl(HTML_404)).toBeNull();
  });

  it("drops an icon past the bound — the item lists carry it", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(FAVICON_MAX_BYTES)]);
    expect(faviconDataUrl(big)).toBeNull();
    expect(faviconDataUrl(big.subarray(0, FAVICON_MAX_BYTES))).not.toBeNull();
  });

  it("reads an inlined icon, base64 or percent-encoded, and nothing that does not parse", () => {
    expect(Buffer.from(dataUrlBytes(`data:image/png;base64,${PNG.toString("base64")}`)!)).toEqual(PNG);
    expect(Buffer.from(dataUrlBytes("data:image/svg+xml,%3Csvg%20viewBox%3D'0%200%201%201'%3E%3C%2Fsvg%3E")!).toString()).toBe("<svg viewBox='0 0 1 1'></svg>");
    expect(dataUrlBytes("data:image/svg+xml,%E0%A4%A")).toBeNull();
    expect(dataUrlBytes("https://a.example/favicon.ico")).toBeNull();
  });
});

describe("readCapped", () => {
  const stream = (chunks: Uint8Array[]) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); },
      cancel() { cancelled = true; },
    });
    return { body, cancelled: () => cancelled };
  };

  it("reads a body that fits, and gives up — cancelling the rest — on one that does not", async () => {
    expect(Buffer.from((await readCapped(stream([PNG.subarray(0, 8), PNG.subarray(8)]).body, 64))!)).toEqual(PNG);
    const huge = stream([Buffer.alloc(40), Buffer.alloc(40), Buffer.alloc(40)]);
    expect(await readCapped(huge.body, 64)).toBeNull();
    expect(huge.cancelled()).toBe(true);
  });
});

describe("createFaviconResolver", () => {
  const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
  const site = (answers: Record<string, Uint8Array | null | Error>) => {
    const asked: string[] = [];
    const fetchBytes = async (url: string) => {
      asked.push(url);
      const a = answers[url];
      if (a instanceof Error) throw a;
      return a ?? null;
    };
    return { asked, resolve: createFaviconResolver(fetchBytes) };
  };

  it("takes the first icon that loads, past one that answered with a page instead", async () => {
    // THE mutant: stop at the first. A site whose favicon-32x32.png 404s but whose favicon.ico is real
    // would draw the glyph.
    const { resolve } = site({ "https://a.example/favicon-32x32.png": HTML_404, "https://a.example/favicon.ico": ICO });
    expect(await resolve(["https://a.example/favicon.ico", "https://a.example/favicon-32x32.png"]))
      .toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
  });

  it("asks a site once for an icon every one of its pages offers", async () => {
    // THE mutant: no memory. Each search would fetch Google's icon again and the tab would wait on it.
    const { asked, resolve } = site({ "https://www.google.com/favicon.ico": ICO, "https://none.example/favicon.ico": null });
    for (let i = 0; i < 3; i++) await resolve(["https://www.google.com/favicon.ico"]);
    for (let i = 0; i < 2; i++) expect(await resolve(["https://none.example/favicon.ico"])).toBeNull();
    expect(asked).toEqual(["https://www.google.com/favicon.ico", "https://none.example/favicon.ico"]);
  });

  it("does not remember a fetch that never answered — the next page asks again", async () => {
    const answers: Record<string, Uint8Array | null | Error> = { "https://a.example/favicon.ico": new Error("timeout") };
    const { asked, resolve } = site(answers);
    expect(await resolve(["https://a.example/favicon.ico"])).toBeNull();
    answers["https://a.example/favicon.ico"] = ICO;
    expect(await resolve(["https://a.example/favicon.ico"])).not.toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("decodes an inlined icon without a request, and tries no more than a few", async () => {
    const { asked, resolve } = site({});
    expect(await resolve([PNG_URL])).toBe(PNG_URL);
    const many = Array.from({ length: FAVICON_TRIES + 3 }, (_, i) => `https://a.example/icon-${i}.ico`);
    expect(await resolve(many)).toBeNull();
    expect(asked).toHaveLength(FAVICON_TRIES);
  });
});

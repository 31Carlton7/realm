import { describe, expect, it } from "vitest";
import type { BrowserSnapshotElement, BrowserSnapshotResult } from "@realm/contracts";
import { findLabel, signature } from "../simulators/executor";
import { DOCUMENT_PATH, NETWORK_QUIET_MS, atRest, pageRole, siteName, walkTreeOf } from "./walk";

/**
 * A page as the walk reads it. What must die: a covered-by-tree-order check turned back on for a page,
 * a place on the page counted as a change, the address left out of what counts as one, a password
 * field read as an ordinary one, a lookalike host named as the social site it imitates, and a read
 * vouched for while the page is still loading or talking to its server.
 */

const e = (ref: number, role: string, name: string, o: Partial<BrowserSnapshotElement> = {}): BrowserSnapshotElement =>
  ({ ref, role, name, value: null, rect: { x: 0, y: 40 * ref, w: 120, h: 24 }, checked: null, disabled: false, password: false, focused: false, offscreen: false, ...o });
const QUIET = { loading: false, requests: 0, quietMs: NETWORK_QUIET_MS };
const SNAP: BrowserSnapshotResult = {
  url: "https://www.instagram.com/explore", title: "Explore", text: "", elementCount: 5, viewport: { width: 1000, height: 700 }, page: QUIET,
  elements: [
    e(7, "link", "Home"), e(8, "textbox", "Search"), e(9, "textbox", "Password", { password: true }),
    e(10, "checkbox", "Remember me", { checked: true, value: "on" }), e(11, "button", "Save", { disabled: true, offscreen: true, rect: { x: 0, y: 2400, w: 80, h: 24 } }),
  ],
};

describe("the site a page is on", () => {
  it("is a social site's app name, wherever on the site the page is", () => {
    expect(["https://www.instagram.com/p/x", "https://instagram.com/", "https://m.facebook.com/", "https://web.whatsapp.com/", "https://x.com/home",
      "https://twitter.com/i/flow", "https://old.reddit.com/r/x", "https://www.threads.net/@a", "https://bsky.app/profile/a", "https://www.youtube.com/watch?v=1"].map(siteName))
      .toEqual(["Instagram", "Instagram", "Facebook", "WhatsApp", "X", "X", "Reddit", "Threads", "Bluesky", "YouTube"]);
  });

  it("is any other site's host, less a leading www. or m. — and never the social site a lookalike imitates", () => {
    expect(siteName("https://www.example.com/a")).toBe("example.com");
    expect(siteName("https://m.example.org/")).toBe("example.org");
    expect(siteName("http://127.0.0.1:8123/docs")).toBe("127.0.0.1");
    // THE MUTANT: a suffix match without its dot. A host that merely ends in a social site's name is
    // not that site, and one that starts with it is somebody else's.
    expect(siteName("https://notinstagram.com/")).toBe("notinstagram.com");
    expect(siteName("https://instagram.com.evil.example/")).toBe("instagram.com.evil.example");
    expect(siteName("about:blank")).toBeNull();
    expect(siteName("not a url")).toBeNull();
    expect(siteName(undefined)).toBeNull();
  });
});

describe("what the browser's report makes of a read", () => {

  it("says a page waiting on a request is not at rest, whatever else is true of it", () => {
    expect(atRest({ ...QUIET, requests: 1 })).toBe(false);
    expect(atRest({ ...QUIET, loading: true, requests: 2, quietMs: 0 })).toBe(false);
  });

  it("says nothing of a page still loading, one whose response just arrived, or one with no report — those are read until two reads agree", () => {
    expect(atRest({ ...QUIET, loading: true })).toBeUndefined();
    expect(atRest({ ...QUIET, quietMs: NETWORK_QUIET_MS - 1 })).toBeUndefined();
    expect(atRest(undefined)).toBeUndefined();
  });
});

describe("a snapshot as the walk reads it", () => {
  it("skips the phone's screen checks, names the site as its app, and carries the browser's word that it is at rest", () => {
    const tree = walkTreeOf(SNAP);
    expect(tree.screenChecks).toBe(false);
    expect(tree.app).toBe("Instagram");
    expect(tree.atRest).toBe(true);
    expect(tree.screen).toEqual({ width: 1000, height: 700 });
    expect(walkTreeOf({ ...SNAP, page: { ...QUIET, requests: 1 } }).atRest).toBe(false);
    expect("atRest" in walkTreeOf({ ...SNAP, page: { ...QUIET, loading: true } })).toBe(false);
  });

  it("finds a label below the fold, where the click that follows will scroll to it", () => {
    expect(findLabel(walkTreeOf(SNAP), "Save")?.el.path).toBe("11");
  });

  it("puts the document first, unnamed, with its address as its value: no label matches it, and a new address is a change", () => {
    const tree = walkTreeOf(SNAP);
    expect(tree.elements[0]).toMatchObject({ path: DOCUMENT_PATH, label: "", value: SNAP.url });
    // The page's title is "Explore" and nothing on it is: a path that says Explore finds nothing to click.
    expect(findLabel(tree, "Explore")).toBeNull();
    // A link to another part of the same page changes nothing but the address.
    expect(signature(walkTreeOf({ ...SNAP, url: `${SNAP.url}#top` }))).not.toBe(signature(tree));
  });

  it("leaves out where an element is, so the scroll a click makes to reach it is not taken for what the click did", () => {
    const scrolled = { ...SNAP, elements: SNAP.elements!.map((x) => ({ ...x, rect: { ...x.rect, y: x.rect.y - 600 }, offscreen: !x.offscreen })) };
    expect(signature(walkTreeOf(scrolled))).toBe(signature(walkTreeOf(SNAP)));
  });

  it("reads a text box as a text field, a password field as a secure one, and a checkbox by its state", () => {
    const [, home, search, password, remember, save] = walkTreeOf(SNAP).elements;
    expect([home!.role, search!.role, password!.role, remember!.role]).toEqual(["link", "text field", "secure text field", "checkbox"]);
    expect([pageRole("searchbox", false), pageRole("spinbutton", false), pageRole("textarea", false), pageRole("combobox", false)])
      .toEqual(["search field", "text field", "text field", "combobox"]);
    expect(remember!.value).toBe("checked");
    expect(save!.enabled).toBe(false);
    // A box ticked is a change the walk can see.
    const unticked = { ...SNAP, elements: SNAP.elements!.map((x) => (x.ref === 10 ? { ...x, checked: false } : x)) };
    expect(signature(walkTreeOf(unticked))).not.toBe(signature(walkTreeOf(SNAP)));
  });

});

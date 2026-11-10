import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { StoreApi } from "zustand";
import { StoreContext, type AppState } from "../../state/store";
import { MessageSources, SourcesCard } from "./MessageSources";
import type { Source } from "./message-sources";

const suggest = vi.fn();
vi.mock("../browser/browser-client", () => ({ getBrowserBridges: () => ({ server: { suggest } }) }));

afterEach(() => { cleanup(); suggest.mockReset(); });

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const sources = (n: number): Source[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://site${i}.test/page`, host: `site${i}.test`, path: "/page" }));

const stack = () => document.querySelector(".msg-sources-stack")!;
const circles = () => [...stack().querySelectorAll(".msg-source-mark:not(.msg-sources-more)")];
const more = () => stack().querySelector(".msg-sources-more");

describe("the sources card's stack", () => {
  it.each([[1, 1, null], [2, 2, null], [3, 3, null], [4, 3, "+1"], [12, 3, "+9"]])(
    "draws %i sources as %i circles and then the count of the rest", (n, drawn, count) => {
      render(<SourcesCard sources={sources(n)} icons={{}} />);
      expect(circles()).toHaveLength(drawn);
      expect(more()?.textContent ?? null).toBe(count);
    });

  it("gives every mark in the stack one size class, the count included", () => {
    render(<SourcesCard sources={sources(12)} icons={{ "site0.test": PNG }} />);
    const marks = [...stack().children];
    expect(marks).toHaveLength(4);
    for (const mark of marks) expect(mark.classList.contains("msg-source-mark")).toBe(true);
  });

  it("draws a site's icon when Realm has one, and its first letter when it has none", () => {
    render(<SourcesCard sources={sources(2)} icons={{ "site0.test": PNG }} />);
    const [withIcon, without] = circles();
    expect(withIcon!.querySelector("img")).toHaveAttribute("src", PNG);
    expect(without!.querySelector("img")).toBeNull();
    expect(without!.textContent).toBe("S");
  });

  it("never draws an address, which the window would refuse and leave as a broken image", () => {
    render(<SourcesCard sources={sources(1)} icons={{ "site0.test": "https://site0.test/favicon.ico" }} />);
    expect(circles()[0]!.querySelector("img")).toBeNull();
    expect(circles()[0]!.textContent).toBe("S");
  });

  it("falls back to the letter when the icon fails to decode", () => {
    render(<SourcesCard sources={sources(1)} icons={{ "site0.test": PNG }} />);
    fireEvent.error(circles()[0]!.querySelector("img")!);
    expect(circles()[0]!.querySelector("img")).toBeNull();
    expect(circles()[0]!.textContent).toBe("S");
  });

  it("looks the first three hosts up in the profile's history, and takes only an exact host's icon", async () => {
    suggest.mockImplementation(async (_space: string, host: string) => host === "site0.test"
      ? [{ url: "https://www.site0.test/a", title: "", visits: 1, lastVisitAt: 0, favicon: PNG }]
      : [{ url: "https://docs.site1.test/a", title: "", visits: 1, lastVisitAt: 0, favicon: PNG }]);
    const store = { getState: () => ({ activeSpaceId: "space-1" }) } as unknown as StoreApi<AppState>;
    render(<StoreContext.Provider value={store}><MessageSources sources={sources(5)} /></StoreContext.Provider>);
    await waitFor(() => expect(circles()[0]!.querySelector("img")).not.toBeNull());
    expect(suggest.mock.calls.map((c) => c[1])).toEqual(["site0.test", "site1.test", "site2.test"]);
    expect(circles()[1]!.querySelector("img")).toBeNull();
  });
});

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

describe("the stack's stylesheet", () => {
  const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";

  it("draws every mark as one circle, and the count at the circles' height", () => {
    const mark = rule(".msg-source-mark");
    expect(mark).toMatch(/width: 16px;/);
    expect(mark).toMatch(/height: 16px;/);
    expect(mark).toMatch(/border-radius: var\(--r-pill\);/);
    expect(rule(".msg-sources-more")).not.toMatch(/height/);
  });
});

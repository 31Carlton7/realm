import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { lazyComponent, loadLazyComponents } from "./lazy-component";

const Hello = ({ name }: { name: string }) => <p>hello {name}</p>;

describe("lazyComponent", () => {
  it("shows the fallback while its chunk loads, then the component", async () => {
    let land!: () => void;
    const Lazy = lazyComponent(() => new Promise<typeof Hello>((r) => { land = () => r(Hello); }));
    render(<Suspense fallback={<p>loading</p>}><Lazy name="a" /></Suspense>);
    expect(screen.getByText("loading")).toBeInTheDocument();
    await act(async () => { land(); await Lazy.preload(); });
    expect(screen.getByText("hello a")).toBeInTheDocument();
  });

  it("renders in the first pass once preloaded — no fallback frame, which React.lazy would draw", async () => {
    const Lazy = lazyComponent(async () => Hello);
    await loadLazyComponents();
    render(<Suspense fallback={<p>loading</p>}><Lazy name="b" /></Suspense>);
    expect(screen.queryByText("loading")).toBeNull();
    expect(screen.getByText("hello b")).toBeInTheDocument();
  });

  it("tries again after a chunk fails to load", async () => {
    let calls = 0;
    const Lazy = lazyComponent(async () => { calls += 1; if (calls === 1) throw new Error("offline"); return Hello; });
    await Lazy.preload();
    await Lazy.preload();
    expect(calls).toBe(2);
    render(<Suspense fallback={null}><Lazy name="c" /></Suspense>);
    expect(screen.getByText("hello c")).toBeInTheDocument();
  });
});

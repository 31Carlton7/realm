import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ICON3D_DENSITIES, ICON3D_SIZES, Icon3D, icon3dSources } from "./Icon3D";

/** The shipped pictures, as the test says they are: every rung of `review` at every density, and
 *  `vault` missing its 3x at the 32 rung. */
const files = vi.hoisted(() => ({} as Record<string, string>));
vi.mock("./icon3d-files", () => ({ ICON3D_FILES: files }));
for (const px of [20, 40, 60, 32, 64, 96, 128, 192]) files[`../assets/icons3d/review-${px}.webp`] = `/assets/review-${px}.webp`;
for (const px of [32, 64]) files[`../assets/icons3d/vault-${px}.webp`] = `/assets/vault-${px}.webp`;

afterEach(cleanup);

const box = (c: HTMLElement) => c.querySelector<HTMLElement>(".i3d")!;
/** jsdom has no AnimationEvent, so the name is set on a plain event the way the browser's carries it. */
const animationEnd = (el: Element, animationName: string) => {
  const e = Object.assign(new Event("animationend", { bubbles: true }), { animationName });
  act(() => { el.dispatchEvent(e); });
};

describe("Icon3D's ladder", () => {
  // Mutant killed: the density not multiplied in (every srcset entry the 1x file).
  it("draws each rung from its 1x, 2x and 3x files", () => {
    for (const size of ICON3D_SIZES) {
      expect(icon3dSources("review", size)).toEqual({
        src: `/assets/review-${size}.webp`,
        srcSet: ICON3D_DENSITIES.map((d) => `/assets/review-${size * d}.webp ${d}x`).join(", "),
      });
    }
  });

  it("draws the picture in a box the size of its rung", () => {
    const { container } = render(<Icon3D name="review" size={32} />);
    expect(box(container)).toHaveAttribute("data-size", "32");
    expect(box(container)).toHaveAttribute("data-icon", "review");
    expect(box(container)).toHaveAttribute("data-art");
    expect(box(container)).toHaveAttribute("aria-hidden", "true");
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("width", "32");
    expect(img).toHaveAttribute("height", "32");
    expect(img).toHaveAttribute("srcset", "/assets/review-32.webp 1x, /assets/review-64.webp 2x, /assets/review-96.webp 3x");
    expect(img).toHaveAttribute("alt", "");
  });
});

describe("Icon3D's fallback", () => {
  // Mutant killed: a picture drawn from whatever densities exist — a 3x screen would get no file.
  it("draws the glyph it stands for, in the same box, while any density is missing", () => {
    expect(icon3dSources("vault", 32)).toBeNull();
    const { container } = render(<Icon3D name="vault" size={32} />);
    expect(container.querySelector("img")).toBeNull();
    expect(box(container)).toHaveAttribute("data-size", "32");
    expect(box(container)).not.toHaveAttribute("data-art");
    expect(box(container).querySelector("svg.i3d-glyph")).not.toBeNull();
  });

  it("draws the glyph for an icon with no picture at all", () => {
    const { container } = render(<Icon3D name="briefcase" size={20} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.i3d-glyph")).toHaveAttribute("height", "16");
  });
});

describe("Icon3D's settle", () => {
  // Mutant killed: settling whenever `selected` is true — a page opening would set its column bouncing.
  it("does not bounce when it is drawn already chosen", () => {
    const { container } = render(<Icon3D name="review" size={20} selected />);
    expect(box(container)).not.toHaveAttribute("data-settle");
  });

  it("bounces once when its row becomes the chosen one, and stops when the bounce ends", () => {
    const { container, rerender } = render(<Icon3D name="review" size={20} selected={false} />);
    rerender(<Icon3D name="review" size={20} selected />);
    expect(box(container)).toHaveAttribute("data-settle");
    animationEnd(container.querySelector("img")!, "some-other");
    expect(box(container)).toHaveAttribute("data-settle");
    animationEnd(container.querySelector("img")!, "i3d-settle");
    expect(box(container)).not.toHaveAttribute("data-settle");
  });

  // Mutant killed: the mark left on when the row is let go — choosing it again would not replay.
  it("bounces again when it is chosen again", () => {
    const { container, rerender } = render(<Icon3D name="review" size={20} selected={false} />);
    rerender(<Icon3D name="review" size={20} selected />);
    rerender(<Icon3D name="review" size={20} selected={false} />);
    expect(box(container)).not.toHaveAttribute("data-settle");
    rerender(<Icon3D name="review" size={20} selected />);
    expect(box(container)).toHaveAttribute("data-settle");
  });
});

describe("Icon3D's motion in the stylesheet", () => {
  const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
  /** The bodies of every `@media (<query>)` block, braces balanced. */
  const media = (query: string) => {
    const out: string[] = [];
    for (let at = css.indexOf(`@media ${query}`); at >= 0; at = css.indexOf(`@media ${query}`, at + 1)) {
      const open = css.indexOf("{", at);
      let depth = 0;
      for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) { out.push(css.slice(open + 1, i)); break; }
      }
    }
    return out.join("\n");
  };

  // Mutant killed: the rule deleted — under Reduce motion the global kill stops the spring, and the
  // lean would then jump in on the hovered frame instead of not happening.
  it("holds a picture still under Reduce motion: no lean, no lift, no bounce", () => {
    const still = media("(prefers-reduced-motion: reduce)");
    expect(still).toMatch(/\.i3d \.i3d-art, \.i3d::before \{ transform: none !important; translate: none !important; scale: none !important; rotate: none !important; \}/);
    expect(still).toContain("*, *::before, *::after { animation: none !important; transition: none !important; }");
  });

  // Mutant killed: the lean outside the hover query — a tap on a touch screen would leave it leaning.
  it("leans only under a pointer that can hover", () => {
    const lean = /:hover \.i3d\[data-art\] \.i3d-art \{ transform:/;
    expect(media("(hover: hover) and (pointer: fine)")).toMatch(lean);
    expect(css.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, "")).not.toMatch(lean);
  });

  it("bounces on the individual transform properties, so the bounce composes with the lean", () => {
    const frames = css.slice(css.indexOf("@keyframes i3d-settle"), css.indexOf("}\n}", css.indexOf("@keyframes i3d-settle")));
    expect(frames).toMatch(/translate: /);
    expect(frames).not.toMatch(/transform:/);
  });
});

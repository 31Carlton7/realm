import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionUsage, contextFraction, contextWindowFor, formatTokens } from "./SessionUsage";
import type { Usage } from "./transcript-model";

afterEach(() => cleanup());

const usage = (over: Partial<Usage> = {}): Usage =>
  ({ costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, ...over });

describe("contextFraction", () => {
  it("is the last prompt against the window, not the session's running input total", () => {
    // The mutant this kills is the tempting one: reading `inputTokens`, which on a cumulative series
    // is every turn ever summed. Here it is already past the window while the real context is a
    // third of it, so a reader of the wrong field reports 100% on a session with room to spare.
    expect(contextFraction(usage({ inputTokens: 900_000, contextTokens: 60_000 }), 180_000)).toBeCloseTo(1 / 3);
  });

  it("has no answer at all when either half is missing", () => {
    expect(contextFraction(usage({ inputTokens: 40_000 }), 180_000)).toBeNull(); // adapter said nothing
    expect(contextFraction(usage({ contextTokens: 40_000 }), null)).toBeNull();  // catalog has no row
    expect(contextFraction(usage({ contextTokens: 40_000 }), 0)).toBeNull();     // a zero window is not a window
  });

  it("clamps a measurement that overran its window rather than reporting past full", () => {
    // A ring cannot draw more than a circle. The overrun is real — a session can sit past a
    // compaction-policy window — and the panel below still prints the measured pair.
    expect(contextFraction(usage({ contextTokens: 240_000 }), 180_000)).toBe(1);
  });

  it("measures against the harness's own window, not the catalog's, when it stated one", () => {
    // The mutant: preferring the catalog. Claude measures occupancy against the AUTOCOMPACT window,
    // which on a 1M-window model is usually the 200K compaction boundary — so a session about to
    // compact would read as 8% full and the ring would stay quiet through the very event it exists
    // to warn about.
    expect(contextWindowFor(usage({ contextWindow: 200_000 }), 1_000_000)).toBe(200_000);
    expect(contextFraction(usage({ contextTokens: 160_000, contextWindow: 200_000 }), 1_000_000)).toBeCloseTo(0.8);
  });

  it("falls back to the catalog only where the harness stated no window", () => {
    expect(contextWindowFor(usage({ contextTokens: 1 }), 180_000)).toBe(180_000);
    expect(contextWindowFor(usage({ contextTokens: 1 }), null)).toBeNull();
  });
});

describe("formatTokens", () => {
  it("reads in the units a context window is quoted in", () => {
    expect(formatTokens(840)).toBe("840");
    expect(formatTokens(1_240)).toBe("1.2k");
    expect(formatTokens(184_320)).toBe("184k");
    expect(formatTokens(1_050_000)).toBe("1.05M");
  });
});

describe("the under-strip's context meter", () => {
  it("draws nothing when the fraction cannot be computed — not an empty ring", () => {
    // Nine of the eleven engines report no tokens at all. An empty ring in every Cursor session would
    // be a claim about that session rather than an admission that Realm cannot see it.
    const { container } = render(<SessionUsage usage={usage({ inputTokens: 5_000 })} contextWindow={180_000} />);
    expect(container.querySelector(".session-usage")).toBeNull();
  });

  it("states the percentage in its accessible name, so the colour is never the only telling", () => {
    render(<SessionUsage usage={usage({ contextTokens: 90_000 })} contextWindow={180_000} />);
    expect(screen.getByRole("button", { name: "Context: 50% of 180k used" })).toBeInTheDocument();
  });

  it("steps its tone at 75% and again at 90%", () => {
    const tone = (contextTokens: number) => {
      cleanup();
      render(<SessionUsage usage={usage({ contextTokens })} contextWindow={100_000} />);
      return document.querySelector(".session-usage-btn")!.getAttribute("data-tone");
    };
    expect(tone(40_000)).toBe("ok");
    expect(tone(74_000)).toBe("ok");
    expect(tone(75_000)).toBe("warning");
    expect(tone(89_000)).toBe("warning");
    expect(tone(90_000)).toBe("danger");
  });

  it("opens the compact stats on hover and on focus alike", () => {
    render(<SessionUsage usage={usage({ contextTokens: 45_000, costUsd: 1.234, outputTokens: 8_100, numTurns: 12 })}
      contextWindow={180_000} />);
    const btn = screen.getByRole("button", { name: /Context/ });
    expect(document.querySelector(".session-usage-panel")).toBeNull();

    fireEvent.focus(btn);
    expect(document.querySelector(".session-usage-panel")).not.toBeNull();
    fireEvent.blur(btn);
    expect(document.querySelector(".session-usage-panel")).toBeNull();

    fireEvent.mouseEnter(document.querySelector(".session-usage")!);
    const rows = [...document.querySelectorAll(".session-usage-row")]
      .map((r) => [r.querySelector(".session-usage-label")!.textContent, r.querySelector(".session-usage-value")!.textContent]);
    expect(rows).toEqual([["Context", "45k / 180k"], ["Cost", "$1.23"], ["Output", "8.1k"], ["Turns", "12"]]);
  });

  it("draws the ring for a harness that states a window the catalog has never heard of", () => {
    // The catalog has no row for a great many models, and used to be the ONLY source of the window —
    // so a session whose harness measures its own occupancy got no meter at all.
    render(<SessionUsage usage={usage({ contextTokens: 50_000, contextWindow: 200_000 })} contextWindow={null} />);
    expect(screen.getByRole("button", { name: "Context: 25% of 200k used" })).toBeInTheDocument();
  });

  it("prints the real pair under a full ring when the session is past its window", () => {
    // The clamp is the ring's, not the truth's. A reader who opens the panel on a pinned meter is
    // owed the measured figure, not the window echoed back at them.
    render(<SessionUsage usage={usage({ contextTokens: 214_000, contextWindow: 200_000, numTurns: 22 })} contextWindow={1_000_000} />);
    fireEvent.mouseEnter(document.querySelector(".session-usage")!);
    const row = [...document.querySelectorAll(".session-usage-row")]
      .find((r) => r.querySelector(".session-usage-label")!.textContent === "Context")!;
    expect(row.querySelector(".session-usage-value")!.textContent).toBe("214k / 200k");
    expect(document.querySelector(".session-usage-btn")!.getAttribute("data-tone")).toBe("danger");
  });

  it("says nothing about cost for an engine that reports none — a $0.000 would be a claim", () => {
    render(<SessionUsage usage={usage({ contextTokens: 45_000, costUsd: 0, numTurns: 3 })} contextWindow={180_000} />);
    fireEvent.mouseEnter(document.querySelector(".session-usage")!);
    const labels = [...document.querySelectorAll(".session-usage-label")].map((n) => n.textContent);
    expect(labels).not.toContain("Cost");
  });
});

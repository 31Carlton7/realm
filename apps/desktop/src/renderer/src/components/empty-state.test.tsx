import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

const SOURCES = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = Object.entries(SOURCES).filter(([name]) => !name.includes(".test.") && !name.endsWith("/EmptyState.tsx"));

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("every empty view draws through EmptyState", () => {
  it("scans the renderer", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(([n]) => n)).toContain("../panes/schedules/SchedulesPage.tsx");
  });

  it("no page or pane builds its own empty layout", () => {
    /* Four layouts for one moment: the Library's bare sentence, Scheduled's centred clock with an
       action, Code review's without one, and the documents pane's dashed tile. THE MUTANT: any one of
       the retired skins back in a component, or a component writing the shared class by hand. */
    const retired = /className="[^"]*\b(pane-empty|pane-empty-tile|page-empty|sched-empty|cr-empty|memory-lib-empty|library-empty|empty-state)[\w-]*/;
    const offenders = files.filter(([, src]) => retired.test(src)).map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("no empty state is a dashed frame", () => {
    const dashed = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /empty/.test(m[1]!) && /dashed/.test(m[2]!))
      .map((m) => m[1]!.trim());
    expect(dashed).toEqual([]);
  });

  it("offers at most one primary action", () => {
    const over: string[] = [];
    for (const [name, src] of files) {
      for (const m of src.matchAll(/<EmptyState\b/g)) {
        const end = src.indexOf("</EmptyState>", m.index);
        const body = src.slice(m.index, end < 0 ? undefined : end);
        if ((body.match(/btn primary/g) ?? []).length > 1) over.push(`${name}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(over).toEqual([]);
  });
});

describe("EmptyState", () => {
  it("is a glyph, a title, one line and its actions, in that order", () => {
    const { container } = render(
      <EmptyState icon="clock" title="Schedule a task" actions={<button type="button" className="btn primary">New task</button>}>
        Realm starts an agent on the clock you set.
      </EmptyState>,
    );
    const root = container.firstElementChild!;
    expect([...root.children].map((c) => c.getAttribute("class"))).toEqual([
      expect.stringContaining("empty-state-mark"), "empty-state-title", "empty-state-line", "empty-state-actions",
    ]);
    expect(screen.getByRole("heading", { level: 2, name: "Schedule a task" })).toBeInTheDocument();
  });

  it("draws nothing it was not given", () => {
    const { container } = render(<EmptyState role="status">Reading the changed files…</EmptyState>);
    expect(container.querySelectorAll(".empty-state > *")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Reading the changed files…");
  });
});

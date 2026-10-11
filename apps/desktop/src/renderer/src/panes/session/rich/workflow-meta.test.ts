import { describe, expect, it } from "vitest";
import { META_LIMIT, TAIL_LIMIT, workflowMeta } from "./workflow-meta";

/** The reader's own source, through Vite as icon-ladder.test.ts reads the renderer. Two of its rules
 *  are about what the module is made of, and only its text can show them. */
const SOURCE = Object.values(import.meta.glob("./workflow-meta.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0] ?? "";

/** The module as code, with its doc comments taken out. They are prose, and they say "imports" and
 *  "pattern" about the module themselves. */
const CODE = SOURCE.replace(/\/\*\*[\s\S]*?\*\//g, "");

/** One backslash, built rather than typed, so every escape below reaches the script under test as
 *  the two characters it is in a script and is not read on the way there. */
const B = String.fromCharCode(92);

/** A script that opens with this `meta` and goes on to a body. */
const script = (meta: string, body = "phase('Work')\nreturn await agent('do the work')"): string => `export const meta = ${meta}\n${body}`;

/** A whole `meta` declaration with nothing after its closing brace, for the tests of what may follow. */
const DECLARED = "export const meta = { name: 'Read the docs', description: 'Reads two files' }";

/** The run the live capture launched, from fixtures/workflow-run.json. Single quotes, on one line. */
const CAPTURED = "export const meta = { name: 'probe-run', description: 'Probe run with two agents', phases: [{ title: 'Work' }] }\nphase('Work')\nconst a = await agent('PROBE-AGENT-A say alpha', { label: 'a' })\nconst b = await agent('PROBE-AGENT-B say beta', { label: 'b' })\nreturn { a, b }";

describe("workflowMeta", () => {
  it("reads the name, the description and the phases of a meta that begins the script", () => {
    expect(workflowMeta(CAPTURED)).toEqual({ name: "probe-run", description: "Probe run with two agents", phases: [{ title: "Work" }] });
  });

  it("leaves phases out of what it returns for a script that declares none", () => {
    const meta = workflowMeta(script("{ name: 'tidy', description: 'Tidy the README' }"));
    expect(meta).toEqual({ name: "tidy", description: "Tidy the README" });
    expect(meta).not.toHaveProperty("phases");
  });

  it("reads past blank lines and both kinds of comment before the meta and between its words", () => {
    const text = "\n\n// what this run is for\n/* and a block\n   over two lines */\n  export /* a */ const /* b */ meta /* c */ = /* d */ { name: 'a', description: 'b' }\nagent('go')";
    expect(workflowMeta(text)).toEqual({ name: "a", description: "b" });
  });

  it("returns null when a statement comes before the meta", () => {
    const meta = "export const meta = { name: 'late', description: 'x' }";
    expect(workflowMeta(`import { helper } from './helper.js'\n${meta}`)).toBeNull();
    expect(workflowMeta(`const limit = 3\n${meta}`)).toBeNull();
    expect(workflowMeta(`'use strict'\n${meta}`)).toBeNull();
  });

  it("takes no meta and no name from a comment, or from text further down the script", () => {
    expect(workflowMeta("// export const meta = { name: 'decoy', description: 'x' }\nreturn await agent('go')")).toBeNull();
    expect(workflowMeta("await agent('go', { name: 'decoy' })\nexport const meta = { name: 'late', description: 'x' }")).toBeNull();
    expect(workflowMeta("export const metadata = { name: 'near', description: 'x' }")).toBeNull();
  });

  it("reads single-, double- and back-quoted strings", () => {
    expect(workflowMeta(script("{ name: \"double\", description: `back\nquoted`, phases: [{ title: 'single' }] }")))
      .toEqual({ name: "double", description: "back\nquoted", phases: [{ title: "single" }] });
  });

  it("reads the escapes a string carries as the text they stand for", () => {
    const meta = `{ name: 'it${B}'s', description: "tab${B}there ${B}u00e9${B}x41 ${B}u{1F600} back${B}${B}slash a${B}\nb" }`;
    expect(workflowMeta(script(meta))).toEqual({
      name: "it's",
      description: `tab\there ${String.fromCodePoint(0xe9)}A ${String.fromCodePoint(0x1f600)} back${B}slash ab`,
    });
  });

  it("returns null for a quoted string it cannot read to its end", () => {
    expect(workflowMeta("export const meta = { name: 'never closed, description: 'x' }")).toBeNull();
    expect(workflowMeta(script("{ name: 'broken\nline', description: 'x' }"))).toBeNull();
    expect(workflowMeta(script(`{ name: 'octal ${B}1', description: 'x' }`))).toBeNull();
    expect(workflowMeta(script(`{ name: 'hex ${B}xZZ', description: 'x' }`))).toBeNull();
  });

  it("returns null when a back-quoted string substitutes a value", () => {
    expect(workflowMeta(script("{ name: `run-${id}`, description: 'x' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'run', description: `Deploy ${target} today` }"))).toBeNull();
  });

  it("reads a back-quoted string that only mentions a dollar sign", () => {
    expect(workflowMeta(script("{ name: 'costs', description: `Costs $5, or {5} in braces` }")))
      .toEqual({ name: "costs", description: "Costs $5, or {5} in braces" });
  });

  it("reads bare keys and quoted keys alike", () => {
    expect(workflowMeta(script("{ 'name': 'a', \"description\": 'b', phases: [{ \"title\": 't', 'detail': 'd' }] }")))
      .toEqual({ name: "a", description: "b", phases: [{ title: "t", detail: "d" }] });
  });

  it("allows a comma after the last entry of a table or a list", () => {
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: [{ title: 't', }, ], }")))
      .toEqual({ name: "a", description: "b", phases: [{ title: "t" }] });
  });

  it("reads past comments inside the literal", () => {
    const meta = "{\n  // the run's name\n  name: /* short */ 'a',\n  description: 'b', /* one line */\n  phases: [\n    // first\n    { title: 't' }, /* last */\n  ],\n}";
    expect(workflowMeta(script(meta))).toEqual({ name: "a", description: "b", phases: [{ title: "t" }] });
  });

  it("ignores keys it has no use for, with the lists and tables nested under them", () => {
    const meta = "{ version: 2, budget: -1.5e3, share: .5, tags: ['x', ['y', { deep: [true, false, null] }]], owner: { team: 'core' }, __proto__: { name: 'other' }, name: 'a', description: 'b' }";
    const read = workflowMeta(script(meta));
    expect(read).toEqual({ name: "a", description: "b" });
    expect(Object.keys(read ?? {})).toEqual(["name", "description"]);
  });

  it("reads past the wider spaces the language allows between tokens", () => {
    for (const code of [0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000]) {
      const s = String.fromCharCode(code);
      expect(workflowMeta(`export${s}const${s}meta${s}=${s}{${s}name:${s}'a',${s}description:${s}'b'${s}}`)).toEqual({ name: "a", description: "b" });
    }
  });

  it("reads a minus sign set apart from its number", () => {
    expect(workflowMeta(script("{ name: 'a', description: 'b', budget: - 1, floor: -\n  2.5, least: - /* at most */ .5e1 }")))
      .toEqual({ name: "a", description: "b" });
  });

  it("returns null for a number written with a leading plus sign, which the harness refuses", () => {
    expect(workflowMeta(script("{ name: 'a', description: 'b', budget: +1 }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', budget: + 1 }"))).toBeNull();
  });

  it("still reads a plus sign inside an exponent, where it is part of the number", () => {
    expect(workflowMeta(script("{ name: 'a', description: 'b', budget: 1e+3, floor: -2E+2 }"))).toEqual({ name: "a", description: "b" });
  });

  it("keeps the last value of a key written twice, as the language does", () => {
    expect(workflowMeta(script("{ name: 'first', description: 'b', name: 'second' }"))).toEqual({ name: "second", description: "b" });
  });

  it("returns null when a value it needs is computed rather than written out", () => {
    expect(workflowMeta(script("{ name: NAME, description: 'b' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'one ' + 'two' }"))).toBeNull();
    expect(workflowMeta(script("{ name: String('a'), description: 'b' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: makePhases() }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: [{ title: pick() }] }"))).toBeNull();
    expect(workflowMeta(script("{ name, description }"))).toBeNull();
    expect(workflowMeta(script("{ ...base, name: 'a', description: 'b' }"))).toBeNull();
  });

  it("returns null when a key it has no use for holds a computed value, which it cannot step over without running it", () => {
    expect(workflowMeta(script("{ name: 'a', description: 'b', budget: limit() }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', started: new Date() }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', [key]: 1 }"))).toBeNull();
  });

  it("returns null when the name or the description is missing, empty or not text", () => {
    expect(workflowMeta(script("{ description: 'b' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: '' }"))).toBeNull();
    expect(workflowMeta(script("{ name: '   ', description: 'b' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 42, description: 'b' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: null }"))).toBeNull();
  });

  it("gives each phase its title, and its detail where it has one", () => {
    const meta = "{ name: 'a', description: 'b', phases: [{ title: 'Plan', detail: 'Read the code', model: 'opus' }, { title: 'Build' }, { title: 'Check', detail: '  ' }] }";
    expect(workflowMeta(script(meta))?.phases).toEqual([{ title: "Plan", detail: "Read the code" }, { title: "Build" }, { title: "Check" }]);
  });

  it("returns null rather than half a meta when the phases it declares cannot be read whole", () => {
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: 'three' }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: ['Plan'] }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: [{ detail: 'no title' }] }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: [{ title: '' }] }"))).toBeNull();
    expect(workflowMeta(script("{ name: 'a', description: 'b', phases: [{ title: 'Plan', detail: 7 }] }"))).toBeNull();
  });

  it("reads a meta that closes on the last character inside the limit, and not one that closes a character later", () => {
    const head = "export const meta = { name: 'a', description: '", tail = "' }";
    const fits = `${head}${"x".repeat(META_LIMIT - head.length - tail.length)}${tail}`;
    expect(fits).toHaveLength(META_LIMIT);
    expect(workflowMeta(`${fits}\nreturn await agent('go')`)?.name).toBe("a");
    expect(workflowMeta(`${head}${"x".repeat(META_LIMIT - head.length - tail.length + 1)}${tail}\nreturn await agent('go')`)).toBeNull();
  });

  it.each([
    { what: "the end of the script", after: "" },
    { what: "nothing but space and a comment", after: "  \n  // nothing more" },
    { what: "a semicolon", after: "; phase('Work')" },
    { what: "a line break and then a word", after: "\nphase('Work')" },
    { what: "a line comment and then a word on the next line", after: " // the body\nreturn await agent('go')" },
    { what: "a block comment that holds the line break", after: " /* the body\n   starts here */ phase('Work')" },
  ])("reads a meta whose literal is followed by $what", ({ after }) => {
    expect(workflowMeta(`${DECLARED}${after}`)).toEqual({ name: "Read the docs", description: "Reads two files" });
  });

  it.each([
    { what: "a member read off it", after: ".alt" },
    { what: "an operator and a second table", after: " && { name: 'wipe', description: 'Deletes the checkout' }" },
    { what: "a conditional", after: " ? a : b" },
    { what: "an index", after: "[k]" },
    { what: "a comma and a second declaration", after: ", other = 1" },
    { what: "a type assertion", after: " satisfies Meta" },
    { what: "a call on the next line", after: "\n(run)()" },
    { what: "a template on the next line", after: "\n`tagged`" },
    { what: "the word in on the next line", after: "\nin scope" },
    { what: "the word instanceof on the next line", after: "\ninstanceof Table" },
    { what: "a word with no line break before it", after: " phase('Work')" },
    { what: "a block comment that never closes", after: "\n/* the body" },
  ])("returns null when the literal is followed by $what", ({ after }) => {
    expect(workflowMeta(`${DECLARED}${after}`)).toBeNull();
  });

  it("returns null for a literal that closes on the last character inside the limit and goes on past it", () => {
    const head = "export const meta = { name: 'a', description: '", tail = "' }";
    const fits = `${head}${"x".repeat(META_LIMIT - head.length - tail.length)}${tail}`;
    expect(fits).toHaveLength(META_LIMIT);
    expect(workflowMeta(`${fits}.x`)).toBeNull();
  });

  it("reads what follows the literal up to a bound of its own, counted from the closing brace", () => {
    const rest = `\n${" ".repeat(TAIL_LIMIT - 8)}phase()`;
    expect(rest).toHaveLength(TAIL_LIMIT);
    expect(workflowMeta(`${DECLARED}${rest}`)).toEqual({ name: "Read the docs", description: "Reads two files" });
  });

  it.each([
    { what: "holds only space", rest: `\n${" ".repeat(TAIL_LIMIT)}phase()` },
    { what: "cuts the word after the line break, which may be the word in", rest: `\n${" ".repeat(TAIL_LIMIT - 2)}in scope` },
  ])("returns null when that bound $what", ({ rest }) => {
    expect(workflowMeta(`${DECLARED}${rest}`)).toBeNull();
  });

  it("returns null for a literal or a comment that never closes, however long the script goes on", () => {
    const entries = "'x', ".repeat(60_000);
    expect(workflowMeta(`export const meta = { name: 'a', description: 'b', tags: [${entries}`)).toBeNull();
    expect(workflowMeta(`/* never closed ${entries}\nexport const meta = { name: 'a', description: 'b' }`)).toBeNull();
  });

  it("gives up on a literal nested deeper than a meta ever is, without running out of stack", () => {
    const nested = (depth: number) => `{ name: 'a', description: 'b', tags: ${"[".repeat(depth)}${"]".repeat(depth)} }`;
    expect(workflowMeta(script(nested(8)))).toEqual({ name: "a", description: "b" });
    expect(workflowMeta(script(nested(40)))).toBeNull();
    expect(workflowMeta(script(nested(4_000)))).toBeNull();
  });

  it("never runs the script, so a value that would leave a mark if evaluated leaves none", () => {
    const probe = globalThis as { realmWorkflowProbe?: string };
    delete probe.realmWorkflowProbe;
    expect(workflowMeta("export const meta = { name: (globalThis.realmWorkflowProbe = 'ran', 'x'), description: 'd' }")).toBeNull();
    expect(workflowMeta("export const meta = { get name() { globalThis.realmWorkflowProbe = 'ran'; return 'x' }, description: 'd' }")).toBeNull();
    expect(probe.realmWorkflowProbe).toBeUndefined();
  });

  it("holds nothing that evaluates text or loads a module", () => {
    expect(CODE.length).toBeGreaterThan(2_000);
    expect(CODE).not.toMatch(/\beval\b|\bFunction\b|\bimport\b|\brequire\b/);
  });

  it("walks the script with no pattern, since its code holds no pattern literal and builds none", () => {
    expect(CODE.length).toBeGreaterThan(2_000);
    expect(CODE).not.toContain("/");
    expect(CODE).not.toMatch(/\bRegExp\b|\.(match|matchAll|replace|replaceAll|search|split|test|exec)\(/);
  });
});

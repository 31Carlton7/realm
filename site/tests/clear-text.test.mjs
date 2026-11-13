// Reads the site's components as source and finds every field that draws detail behind its siblings:
// the hero's sky (a <Sky>, which masks its stars from its parent's `data-clear` blocks) and the
// worlds (a <World>, a dithered picture nothing masks). Text inside a sky must sit in a `data-clear`
// block, at most as many as the shader can hold; text inside a world's box is not allowed at all. A
// component the site defines (the shared <Header>) is read through to the JSX it returns, so a sky is
// checked down to the words it actually draws, on the landing page and on every page under <Subpage>.

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { MAX_CLEAR } from "../components/landing/star-mask.ts"

const site = fileURLToPath(new URL("..", import.meta.url))

/** Components that draw no words of their own. */
const WORDLESS = new Set(["Sky", "World", "Crop", "Mark"])

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : sources(path)
    return e.name.endsWith(".tsx") ? [path] : []
  })
}

const tagOf = (el) => (ts.isJsxElement(el) ? el.openingElement : el).tagName.getText()
const attrsOf = (el) => (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties
const isClear = (el) => attrsOf(el).some((a) => ts.isJsxAttribute(a) && a.name.getText() === "data-clear")
const childrenOf = (el) => (ts.isJsxElement(el) || ts.isJsxFragment(el) ? el.children : [])
const isElement = (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)
const isJsx = (n) => isElement(n) || ts.isJsxFragment(n)

const parsed = sources(site).map((file) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
)

/** Each component the site defines as a named function, by name: the outermost JSX it returns. */
const definitions = new Map()
for (const src of parsed) {
  for (const statement of src.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !/^[A-Z]/.test(statement.name.text)) continue
    const roots = []
    const find = (n) => (isJsx(n) ? roots.push(n) : ts.forEachChild(n, find))
    if (statement.body) find(statement.body)
    const name = statement.name.text
    definitions.set(name, [...(definitions.get(name) ?? []), ...roots])
  }
}

/** The JSX a component draws, if the site defines it and it is not already being read (a cycle). */
const drawnBy = (tag, reading) => (definitions.has(tag) && !reading.has(tag) ? definitions.get(tag) : null)

/** Each piece of text under `el` (words, an expression, a component that renders words), and whether a `data-clear` block holds it. */
function textUnder(el, clear, out, reading = new Set()) {
  for (const child of childrenOf(el)) visitChild(child, clear, out, reading)
  return out
}

function visitChild(child, clear, out, reading) {
  if (ts.isJsxText(child)) {
    if (child.getText().trim()) out.push({ node: child, clear })
  } else if (ts.isJsxExpression(child)) {
    const e = child.expression
    if (!e || (ts.isStringLiteral(e) && !e.text.trim())) return
    // `{aside && <Crop />}` or `{list.map(...)}` renders the JSX in it; anything else renders as text.
    const jsx = []
    const find = (n) => (isElement(n) || ts.isJsxFragment(n) ? jsx.push(n) : ts.forEachChild(n, find))
    find(e)
    if (jsx.length === 0) out.push({ node: child, clear })
    for (const n of jsx) visitChild(n, clear, out, reading)
  } else if (ts.isJsxFragment(child)) {
    textUnder(child, clear, out, reading)
  } else if (isElement(child)) {
    const tag = tagOf(child)
    const marked = clear || isClear(child)
    const drawn = /^[A-Z]/.test(tag) && !WORDLESS.has(tag) ? drawnBy(tag, reading) : null
    if (drawn) {
      const deeper = new Set(reading).add(tag)
      for (const root of drawn) visitChild(root, marked, out, deeper)
    } else if (/^[A-Z]/.test(tag) && !WORDLESS.has(tag)) out.push({ node: child, clear: marked })
    textUnder(child, marked, out, reading)
  }
}

/** Every JSX element in the site whose own children include a field, with its file. */
function fields() {
  const found = []
  for (const src of parsed) {
    const file = src.fileName
    const visit = (n) => {
      if (ts.isJsxElement(n)) {
        for (const child of n.children) {
          if (isElement(child) && (tagOf(child) === "Sky" || tagOf(child) === "World")) {
            found.push({ file: relative(site, file), src, region: n, kind: tagOf(child) })
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(src)
  }
  return found
}

const where = (_field, node) => {
  const src = node.getSourceFile()
  return `${relative(site, src.fileName)}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
}
const shown = (node) => node.getText().replace(/\s+/g, " ").slice(0, 60)

test("every word over a sky sits in a data-clear block", () => {
  const skies = fields().filter((f) => f.kind === "Sky")
  const files = new Set(skies.map((sky) => sky.file))
  for (const file of ["components/landing/Hero.tsx", "components/landing/Subpage.tsx"]) {
    assert.ok(files.has(file), `found no <Sky> in ${file}: this test does not read that sky`)
  }
  for (const sky of skies) {
    const text = textUnder(sky.region, false, [])
    assert.ok(text.length > 0, `${where(sky, sky.region)}: the sky holds no text, so this test reads nothing`)
    const bare = text.filter((t) => !t.clear).map((t) => `${where(sky, t.node)} ${shown(t.node)}`)
    assert.deepEqual(bare, [], "text over the sky outside any data-clear block, where a star can land on it")

    const blocks = []
    const count = (el, reading) => {
      for (const c of childrenOf(el)) {
        if (isElement(c) && isClear(c)) blocks.push(c)
        const drawn = isElement(c) ? drawnBy(tagOf(c), reading) : null
        if (drawn) for (const root of drawn) count({ children: [root] }, new Set(reading).add(tagOf(c)))
        if (isElement(c)) count(c, reading)
      }
    }
    count(sky.region, new Set())
    assert.ok(blocks.length <= MAX_CLEAR, `${where(sky, sky.region)}: ${blocks.length} data-clear blocks, the shader clears ${MAX_CLEAR}`)
  }
})

test("no words sit inside a world's box", () => {
  const worlds = fields().filter((f) => f.kind === "World")
  assert.ok(worlds.length > 0, "found no <World> in the site: this test reads nothing")
  for (const world of worlds) {
    const text = textUnder(world.region, false, []).map((t) => `${where(world, t.node)} ${shown(t.node)}`)
    assert.deepEqual(text, [], "text inside a world's box, where nothing masks the picture's detail")
  }
})

/** Pages kept on the earlier design on purpose: the rollback home, and the share images' sources. */
const EARLIER = ["app/2025/", "app/share/"]
/** What only the earlier design draws: the realms' field, its panes, and its header and footer. */
const EARLIER_PARTS = /from "@\/components\/(realms\/(?!Screen")|changelog\/Field"|field\/|SiteHeader"|SiteFooter"|FloatingHeader")/

test("every other page stands on the landing page's ground, with none of the earlier field", () => {
  const pages = parsed
    .map((src) => relative(site, src.fileName))
    .filter((file) => file.startsWith("app/") && /\/(page|layout|not-found)\.tsx$/.test(file))
    .filter((file) => !EARLIER.some((dir) => file.startsWith(dir)))
  assert.ok(pages.length > 5, "found almost no pages: this test reads nothing")
  const old = pages.filter((file) => EARLIER_PARTS.test(readFileSync(join(site, file), "utf8")))
  assert.deepEqual(old, [], "a page still draws a part of the earlier design")
  for (const file of ["app/changelog/page.tsx", "app/changelog/[slug]/page.tsx", "app/docs/layout.tsx", "app/not-found.tsx"]) {
    assert.match(readFileSync(join(site, file), "utf8"), /<Subpage\b/, `${file} is not set on <Subpage>`)
  }
})

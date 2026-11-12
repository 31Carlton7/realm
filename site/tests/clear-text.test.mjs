// Reads the site's components as source and finds every field that draws detail behind its siblings:
// the hero's sky (an <Aperture>, which masks its stars from its parent's `data-clear` blocks) and the
// worlds (a <World>, a dithered picture nothing masks). Text inside a sky must sit in a `data-clear`
// block, at most as many as the shader can hold; text inside a world's box is not allowed at all.

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { MAX_CLEAR } from "../components/landing/star-mask.ts"

const site = fileURLToPath(new URL("..", import.meta.url))

/** Components that draw no words of their own. */
const WORDLESS = new Set(["Aperture", "World", "Crop", "Mark"])

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

/** Each piece of text under `el` (words, an expression, a component that renders words), and whether a `data-clear` block holds it. */
function textUnder(el, clear, out) {
  for (const child of childrenOf(el)) visitChild(child, clear, out)
  return out
}

function visitChild(child, clear, out) {
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
    for (const n of jsx) visitChild(n, clear, out)
  } else if (ts.isJsxFragment(child)) {
    textUnder(child, clear, out)
  } else if (isElement(child)) {
    const tag = tagOf(child)
    const marked = clear || isClear(child)
    if (/^[A-Z]/.test(tag) && !WORDLESS.has(tag)) out.push({ node: child, clear: marked })
    textUnder(child, marked, out)
  }
}

/** Every JSX element in the site whose own children include a field, with its file. */
function fields() {
  const found = []
  for (const file of sources(site)) {
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (n) => {
      if (ts.isJsxElement(n)) {
        for (const child of n.children) {
          if (isElement(child) && (tagOf(child) === "Aperture" || tagOf(child) === "World")) {
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

const where = ({ file, src }, node) => `${file}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
const shown = (node) => node.getText().replace(/\s+/g, " ").slice(0, 60)

test("every word over the hero's sky sits in a data-clear block", () => {
  const skies = fields().filter((f) => f.kind === "Aperture")
  assert.ok(skies.length > 0, "found no <Aperture> in the site: this test reads nothing")
  for (const sky of skies) {
    const text = textUnder(sky.region, false, [])
    assert.ok(text.length > 0, `${where(sky, sky.region)}: the sky holds no text, so this test reads nothing`)
    const bare = text.filter((t) => !t.clear).map((t) => `${where(sky, t.node)} ${shown(t.node)}`)
    assert.deepEqual(bare, [], "text over the sky outside any data-clear block, where a star can land on it")

    const blocks = []
    const count = (el) => {
      for (const c of childrenOf(el)) {
        if (isElement(c) && isClear(c)) blocks.push(c)
        if (isElement(c)) count(c)
      }
    }
    count(sky.region)
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

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CLEAR_MARGIN,
  MAX_CLEAR,
  STAR_GROWTH,
  STAR_SIZE,
  clearBoxes,
  distanceTo,
  keepsStar,
  starReach,
  toShader,
} from "../components/landing/star-mask.ts"

// mulberry32: the same stars on every run, so a failure names the case that broke.
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const W = 1440
const H = 1100

function textBlocks(rand) {
  const n = 1 + Math.floor(rand() * MAX_CLEAR)
  return Array.from({ length: n }, () => {
    const left = rand() * (W - 40)
    const top = rand() * (H - 20)
    // From a word of caption to a whole lede.
    return { left, top, right: left + 20 + rand() * 600, bottom: top + 14 + rand() * 180 }
  })
}

// Most stars anywhere in the sky, the rest hugging a block's edge, where a mistake would show.
function starAt(rand, blocks) {
  if (rand() < 0.5) return [rand() * W, rand() * H]
  const b = blocks[Math.floor(rand() * blocks.length)]
  const out = rand() * (CLEAR_MARGIN + 6)
  const side = Math.floor(rand() * 4)
  const along = (lo, hi) => lo + rand() * (hi - lo)
  if (side === 0) return [b.left - out, along(b.top, b.bottom)]
  if (side === 1) return [b.right + out, along(b.top, b.bottom)]
  if (side === 2) return [along(b.left, b.right), b.top - out]
  return [along(b.left, b.right), b.bottom + out]
}

test("no star the sky keeps reaches a block of text", () => {
  const rand = random(0x5ca1ab1e)
  let kept = 0
  let dropped = 0
  for (let trial = 0; trial < 300; trial++) {
    const blocks = textBlocks(rand)
    const clear = clearBoxes(blocks)
    for (let i = 0; i < 2000; i++) {
      const [x, y] = starAt(rand, blocks)
      if (!keepsStar(clear, x, y)) {
        dropped++
        continue
      }
      kept++
      const reach = starReach(rand())
      for (const b of blocks) {
        assert.ok(
          distanceTo(b, x, y) > reach,
          `trial ${trial}: a star at (${x.toFixed(1)}, ${y.toFixed(1)}) reaching ${reach.toFixed(2)}px touches text at ${JSON.stringify(b)}`,
        )
      }
    }
  }
  // Neither half is empty, so the check above is not passing on nothing.
  assert.ok(kept > 100_000 && dropped > 50_000, `kept ${kept}, dropped ${dropped}`)
})

test("the margin covers the brightest star's reach", () => {
  assert.ok(CLEAR_MARGIN > starReach(1), `margin ${CLEAR_MARGIN} vs reach ${starReach(1)}`)
  // At STAR_REACH radii the gaussian exp(-d²/size²) is under 1/255 of its peak.
  assert.ok(Math.exp(-(starReach(1) ** 2) / (STAR_SIZE + STAR_GROWTH) ** 2) < 1 / 255)
})

test("a box reaches the shader flipped to the canvas's lower left, in device px", () => {
  const canvas = { left: 0, top: -200, right: 1440, bottom: 900 }
  assert.deepEqual(toShader({ left: 100, top: 300, right: 400, bottom: 360 }, canvas, 2), [200, 1080, 800, 1200])
})

// The macOS app icon shape, measured: the radius at which Apple's continuous corner (icons.mjs's body)
// matches the body macOS itself draws for an app, and how close the two edges are.
//
//   swift shape.swift                                   # against Finder, at the radius icons.mjs uses
//   swift shape.swift /System/Applications/Mail.app     # against any app
//   swift shape.swift path 214.5                        # Apple's continuous rounded rect on the icon grid
//
// The system's picture is AppKit's own rendering of the app's icon at 1024 px, which is what the Dock
// and the Finder draw. Its alpha is the body and the shadow beneath it, and the shadow is taken off by
// reading it from the pixel just outside the edge, where the body covers nothing. Edges are compared
// along their normal — rows where the edge runs steeply, columns where it runs flat — so a nearly level
// stretch of curve cannot pass a horizontal run off as a distance.
import AppKit
import SwiftUI

let N = 1024
let grid = CGRect(x: 100, y: 100, width: 824, height: 824)

func continuous(_ r: CGFloat) -> CGPath {
  Path(roundedRect: grid, cornerRadius: r, style: .continuous).cgPath
}

/** Row-major alpha, top row first, 0...1. */
func alpha(of draw: (CGContext) -> Void) -> [Float] {
  var px = [UInt8](repeating: 0, count: N * N * 4)
  let ctx = CGContext(data: &px, width: N, height: N, bitsPerComponent: 8, bytesPerRow: N * 4,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  // Top-down, like the file it is compared with.
  ctx.translateBy(x: 0, y: CGFloat(N)); ctx.scaleBy(x: 1, y: -1)
  draw(ctx)
  return (0..<(N * N)).map { Float(px[$0 * 4 + 3]) / 255 }
}

func systemAlpha(_ app: String) -> [Float] {
  let icon = NSWorkspace.shared.icon(forFile: app)
  return alpha { ctx in
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    icon.draw(in: NSRect(x: 0, y: 0, width: N, height: N), from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
  }
}

func shapeAlpha(_ r: CGFloat) -> [Float] {
  alpha { ctx in ctx.addPath(continuous(r)); ctx.setFillColor(.black); ctx.fillPath() }
}

/** How far the edge sits in from the body's bounds along each row and column of the top-left quarter,
 *  in pixels: what the body leaves uncovered between the bound and the centre line. The shadow under
 *  the edge is the alpha just outside it, where the body covers nothing. */
func insets(_ a: [Float]) -> (rows: [Float], cols: [Float]) {
  func line(_ at: (Int) -> Float) -> Float {
    var x = 60
    while x < 512 && at(x) < 0.5 { x += 1 }
    var start = x
    while start > 60 && at(start - 1) > at(start - 2) + 0.004 { start -= 1 }
    let shade = at(start - 1)
    var gap = Float(start - 100)
    for i in start..<512 { gap += 1 - min(1, max(0, (at(i) - shade) / (1 - shade))) }
    return gap
  }
  let rows = (100..<512).map { y in line { a[y * N + $0] } }
  let cols = (100..<512).map { x in line { a[$0 * N + x] } }
  return (rows, cols)
}

/** How far each edge pixel's coverage differs, in the top half of the body, where the shadow is
 *  lightest: max and mean of |Δα|, the system's taken off its shadow as `insets` does. */
func pixelError(_ sys: [Float], _ got: [Float]) -> (max: Float, mean: Float) {
  var worst: Float = 0, sum: Float = 0, n: Float = 0
  for y in 100..<512 {
    let at = { (x: Int) in sys[y * N + x] }
    var x = 60
    while x < 924 && at(x) < 0.5 { x += 1 }
    var start = x
    while start > 60 && at(start - 1) > at(start - 2) + 0.004 { start -= 1 }
    let shade = at(start - 1)
    for i in max(60, start - 2)..<min(1024 - 60, start + 200) {
      let c = min(1, max(0, (at(i) - shade) / (1 - shade))), g = got[y * N + i]
      guard (c > 0.01 && c < 0.99) || (g > 0.01 && g < 0.99) else { continue }
      worst = max(worst, abs(c - g)); sum += abs(c - g); n += 1
    }
  }
  return (worst, sum / max(1, n))
}

/** The distance between two edges along the normal: max and mean, in pixels. */
func edgeError(_ ref: (rows: [Float], cols: [Float]), _ got: (rows: [Float], cols: [Float])) -> (max: Float, mean: Float) {
  var errors: [Float] = []
  for (r, g) in [(ref.rows, got.rows), (ref.cols, got.cols)] {
    for i in 1..<(r.count - 1) where r[i] > 0.05 {
      let slope = (r[i + 1] - r[i - 1]) / 2
      if abs(slope) <= 1 { errors.append(abs(g[i] - r[i]) / (1 + slope * slope).squareRoot()) }
    }
  }
  return (errors.max() ?? 0, errors.reduce(0, +) / Float(max(1, errors.count)))
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "path", args.count > 1, let r = Double(args[1]) {
  var d = ""
  continuous(CGFloat(r)).applyWithBlock { el in
    let p = el.pointee.points
    switch el.pointee.type {
    case .moveToPoint: d += String(format: "M%.4f %.4f", p[0].x, p[0].y)
    case .addLineToPoint: d += String(format: "L%.4f %.4f", p[0].x, p[0].y)
    case .addCurveToPoint: d += String(format: "C%.4f %.4f %.4f %.4f %.4f %.4f", p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y)
    case .addQuadCurveToPoint: d += String(format: "Q%.4f %.4f %.4f %.4f", p[0].x, p[0].y, p[1].x, p[1].y)
    case .closeSubpath: d += "Z"
    @unknown default: break
    }
  }
  print(d)
  exit(0)
}

/** The radius icons.mjs draws the body with. */
let shipped: CGFloat = 214.5
let app = args.first ?? "/System/Library/CoreServices/Finder.app"
let sys = systemAlpha(app)
let ref = insets(sys)
func error(_ r: CGFloat) -> (max: Float, mean: Float) { edgeError(ref, insets(shapeAlpha(r))) }
var best: (r: CGFloat, e: (max: Float, mean: Float)) = (0, (.infinity, .infinity))
for r in stride(from: 150.0, through: 300.0, by: 1.0) {
  let e = error(CGFloat(r)); if e.mean < best.e.mean { best = (CGFloat(r), e) }
}
for r in stride(from: Double(best.r) - 1, through: Double(best.r) + 1, by: 0.1) {
  let e = error(CGFloat(r)); if e.mean < best.e.mean { best = (CGFloat(r), e) }
}
let name = (app as NSString).lastPathComponent
print(String(format: "%@: Apple's continuous corner fits best at r = %.1f px on the 824 px body (edge error along the normal: max %.3f px, mean %.4f px)",
  name, Double(best.r), best.e.max, best.e.mean))
let e = error(shipped), p = pixelError(sys, shapeAlpha(shipped))
print(String(format: "%@ at r = %.1f px, the radius icons.mjs uses: edge error along the normal max %.3f px, mean %.4f px; edge pixels' coverage |Δα| max %.3f, mean %.4f",
  name, Double(shipped), e.max, e.mean, p.max, p.mean))

import RealmKit
import SwiftUI
import UIKit

/// A teammate's mark, as the Mac draws it (`packages/ui/src/teammate-icon`): one flat shape in its
/// colour and two short eye strokes, and nothing else. It says who, never how it is doing — state is
/// the dot beside it. The Lead's star is cut into the bottom-right corner with a gap round it.
///
/// The geometry is the desktop's, on the same 64-unit square, and the eyes are laid on the pixel grid
/// of the size they are drawn at, as there: a two-pixel stroke that straddles a pixel is a smudge.
struct TeammateMark: View {
    let icon: TeammateIcon?
    let size: CGFloat
    var lead = false
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let shape = TeammateShape(icon?.shape)
        let body = TeammatePalette.body(icon?.color, dark: colorScheme == .dark)
        let eye = TeammatePalette.eye(dark: colorScheme == .dark)
        let star = TeammatePalette.star(dark: colorScheme == .dark)
        let pixels = size * displayScale
        Canvas { context, canvas in
            let scale = canvas.width / 64
            context.scaleBy(x: scale, y: scale)
            let starPath = TeammateGeometry.leadStar(pixels: pixels)
            context.drawLayer { layer in
                layer.fill(TeammateGeometry.path(shape), with: .color(body))
                let eyes = TeammateGeometry.eyes(face: TeammateGeometry.face(shape), pixels: pixels)
                layer.stroke(eyes.path, with: .color(eye), style: StrokeStyle(lineWidth: eyes.width, lineCap: .round))
                if lead {
                    layer.blendMode = .destinationOut
                    layer.fill(starPath.path, with: .color(.black))
                    layer.stroke(starPath.path, with: .color(.black), style: StrokeStyle(lineWidth: starPath.cut, lineJoin: .round))
                }
            }
            if lead {
                context.fill(starPath.path, with: .color(star))
                context.stroke(starPath.path, with: .color(star), style: StrokeStyle(lineWidth: starPath.soften, lineJoin: .round))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The eight silhouettes, by the desktop's names. One this phone does not know is drawn as a circle.
enum TeammateShape: String, CaseIterable {
    case circle, flower, squircle, pill, triangle, hexagon, cloud, drop

    init(_ name: String?) { self = name.flatMap(Self.init(rawValue:)) ?? .circle }

    /// As the Edit sheet names them.
    var label: String {
        switch self {
        case .circle: "Circle"
        case .flower: "Flower"
        case .squircle: "Rounded square"
        case .pill: "Pill"
        case .triangle: "Triangle"
        case .hexagon: "Hexagon"
        case .cloud: "Cloud"
        case .drop: "Drop"
        }
    }
}

/// The twelve colours at one lightness per face, as `palette.ts` sets them: only the hue moves, so the
/// set reads as one family. A teammate stores the name, never the value.
enum TeammatePalette {
    static let colors: [(name: String, label: String, hue: Double, chroma: Double)] = [
        ("red", "Red", 25, 0.15), ("orange", "Orange", 50, 0.15), ("amber", "Amber", 72, 0.13),
        ("yellow", "Yellow", 95, 0.128), ("lime", "Lime", 125, 0.15), ("green", "Green", 152, 0.15),
        ("teal", "Teal", 188, 0.106), ("sky", "Sky", 228, 0.122), ("blue", "Blue", 260, 0.15),
        ("violet", "Violet", 296, 0.15), ("pink", "Pink", 350, 0.15), ("graphite", "Graphite", 264, 0.014),
    ]

    static func body(_ name: String?, dark: Bool) -> Color {
        let color = colors.first { $0.name == name } ?? colors[11]
        return oklch(dark ? 0.645 : 0.605, color.chroma, color.hue)
    }

    /// Every colour's body for both faces at once, for a swatch beside the icons it picks for.
    static func body(_ name: String) -> Color {
        Color(UIColor { traits in UIColor(body(name, dark: traits.userInterfaceStyle == .dark)) })
    }

    /// White on the dark face; on the light one a near-white of its own paper.
    static func eye(dark: Bool) -> Color { dark ? oklch(1, 0, 0) : oklch(0.985, 0.002, 264) }

    /// The Lead's star: one gold, lighter than every body.
    static func star(dark: Bool) -> Color { dark ? oklch(0.86, 0.15, 86) : oklch(0.72, 0.16, 76) }

    /// An OKLCH colour in sRGB (Björn Ottosson's matrices), each channel held to the gamut.
    static func oklch(_ l: Double, _ c: Double, _ h: Double) -> Color {
        let a = c * cos(h * .pi / 180), b = c * sin(h * .pi / 180)
        let l3 = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m3 = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s3 = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
        let linear = [
            4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
            -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
            -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
        ]
        let encoded = linear.map { v -> Double in
            let x = min(max(v, 0), 1)
            return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
        }
        return Color(.sRGB, red: encoded[0], green: encoded[1], blue: encoded[2])
    }
}

/// `shapes.ts` and `TeammateIcon.tsx`'s geometry on the 64-unit square.
enum TeammateGeometry {
    private static let centre: CGFloat = 32

    static func path(_ shape: TeammateShape) -> Path {
        var path = Path()
        switch shape {
        case .circle:
            path.addPath(circle(32, 32, 27))
        case .flower:
            path.addPath(circle(32, 32, 17))
            for petal in regular(5, 15.5, -90) { path.addPath(circle(petal.x, petal.y, 12.5)) }
        case .squircle:
            path.addPath(squircle(half: 25, n: 4.6, degrees: -8))
        case .pill:
            path.addPath(capsule(rotate(CGPoint(x: 20, y: 32), -12), rotate(CGPoint(x: 44, y: 32), -12), 17.5))
        case .triangle:
            path.addPath(roundedPolygon(regular(3, 38, -96, cy: 38), 10))
        case .hexagon:
            path.addPath(roundedPolygon(regular(6, 29, -82), 7))
        case .cloud:
            path.addPath(capsule(CGPoint(x: 17, y: 41), CGPoint(x: 47, y: 41), 14))
            path.addPath(circle(23, 31, 12))
            path.addPath(circle(37.5, 26.5, 15.5))
            path.addPath(circle(49, 37, 10))
        case .drop:
            path.addPath(drop(tip: rotate(CGPoint(x: 32, y: 4), -18), centre: rotate(CGPoint(x: 32, y: 39), -18), r: 21, tipR: 4))
        }
        return path
    }

    /// Where the pair of eyes is centred, up and to the right of the mass's middle.
    static func face(_ shape: TeammateShape) -> CGPoint {
        switch shape {
        case .circle: CGPoint(x: 34, y: 29)
        case .flower: CGPoint(x: 33.5, y: 30.5)
        case .squircle: CGPoint(x: 34, y: 29.5)
        case .pill: CGPoint(x: 33, y: 30)
        case .triangle: CGPoint(x: 31.5, y: 36.5)
        case .hexagon: CGPoint(x: 34, y: 30)
        case .cloud: CGPoint(x: 35, y: 35)
        case .drop: CGPoint(x: 32.5, y: 36.5)
        }
    }

    /// The two eye strokes for an icon `pixels` device pixels across: whole-pixel widths, edges on
    /// pixel boundaries, and a lean cut back at the small sizes (`eyeStrokes`).
    static func eyes(face: CGPoint, pixels: CGFloat) -> (path: Path, width: CGFloat) {
        let s = pixels / 64
        let w = max(2, (5.5 * s).rounded())
        let len = max(2, (8 * s).rounded())
        let gap = max(w + 2, (12.5 * s).rounded())
        let lean = (pixels < 28 ? 8 : 15) * CGFloat.pi / 180
        let total = len + w
        let x0 = (face.x * s - gap / 2 - w / 2).rounded() + w / 2
        let y0 = (face.y * s - total / 2).rounded() + total / 2
        let dx = sin(lean) * len / 2, dy = cos(lean) * len / 2
        var path = Path()
        for x in [x0, x0 + gap] {
            path.move(to: CGPoint(x: (x - dx) / s, y: (y0 + dy) / s))
            path.addLine(to: CGPoint(x: (x + dx) / s, y: (y0 - dy) / s))
        }
        return (path, w / s)
    }

    /// The Lead's star, sized in pixels rather than as a share of the square, so it reads at row size
    /// and never reaches the eyes (`leadStar`). `cut` is the gap's stroke, `soften` rounds its points.
    static func leadStar(pixels: CGFloat) -> (path: Path, soften: CGFloat, cut: CGFloat) {
        let s = pixels / 64
        let r = max(3.6, pixels * 0.17) / s
        let gap = max(1, pixels * 0.035) / s
        let inset: CGFloat = pixels < 28 ? 0.72 : 0.9
        let cx = 64 - r * inset, cy = 64 - r * inset
        var path = Path()
        for i in 0..<10 {
            let radius = (i % 2 == 1 ? 0.5 : 0.9) * r
            let a = (-90 + CGFloat(i) * 36) * .pi / 180
            let point = CGPoint(x: cx + radius * cos(a), y: cy + radius * sin(a))
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        let soften = r * 0.2
        return (path, soften, soften + gap * 2)
    }

    private static func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
    }

    private static func rotate(_ p: CGPoint, _ degrees: CGFloat) -> CGPoint {
        let r = degrees * .pi / 180, c = cos(r), s = sin(r)
        return CGPoint(x: centre + (p.x - centre) * c - (p.y - centre) * s, y: centre + (p.x - centre) * s + (p.y - centre) * c)
    }

    private static func regular(_ sides: Int, _ radius: CGFloat, _ startDegrees: CGFloat, cy: CGFloat = 32) -> [CGPoint] {
        (0..<sides).map { i in
            let a = (startDegrees + 360 / CGFloat(sides) * CGFloat(i)) * .pi / 180
            return CGPoint(x: centre + radius * cos(a), y: cy + radius * sin(a))
        }
    }

    /// A polygon with every corner rounded by a true arc of radius `r`.
    private static func roundedPolygon(_ v: [CGPoint], _ r: CGFloat) -> Path {
        var path = Path()
        let last = v[v.count - 1], first = v[0]
        path.move(to: CGPoint(x: (last.x + first.x) / 2, y: (last.y + first.y) / 2))
        for i in v.indices {
            path.addArc(tangent1End: v[i], tangent2End: v[(i + 1) % v.count], radius: r)
        }
        path.closeSubpath()
        return path
    }

    /// A superellipse, sampled finely enough that no facet shows at 64 points.
    private static func squircle(half: CGFloat, n: CGFloat, degrees: CGFloat) -> Path {
        var path = Path()
        for i in 0..<96 {
            let t = CGFloat(i) / 96 * 2 * .pi, c = cos(t), s = sin(t)
            let p = rotate(CGPoint(x: centre + half * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n),
                                   y: centre + half * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)), degrees)
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        return path
    }

    /// A capsule from its two cap centres.
    private static func capsule(_ a: CGPoint, _ b: CGPoint, _ r: CGFloat) -> Path {
        let angle = atan2(b.y - a.y, b.x - a.x)
        var path = Path()
        path.addArc(center: b, radius: r, startAngle: .radians(angle - .pi / 2), endAngle: .radians(angle + .pi / 2), clockwise: false)
        path.addArc(center: a, radius: r, startAngle: .radians(angle + .pi / 2), endAngle: .radians(angle + .pi * 1.5), clockwise: false)
        path.closeSubpath()
        return path
    }

    /// A drop: a round belly and two straight sides tangent to it, meeting at a softened tip.
    private static func drop(tip: CGPoint, centre belly: CGPoint, r: CGFloat, tipR: CGFloat) -> Path {
        let dx = belly.x - tip.x, dy = belly.y - tip.y, dist = hypot(dx, dy)
        let half = asin(r / dist), base = atan2(dy, dx), reach = sqrt(dist * dist - r * r)
        let along = { (a: CGFloat, d: CGFloat) in CGPoint(x: tip.x + cos(a) * d, y: tip.y + sin(a) * d) }
        let right = along(base - half, reach), left = along(base + half, reach)
        var path = Path()
        path.move(to: left)
        path.addArc(tangent1End: tip, tangent2End: right, radius: tipR)
        path.addLine(to: right)
        // Round the far side of the belly, away from the tip, back to where the left side meets it.
        let from = atan2(right.y - belly.y, right.x - belly.x)
        let to = atan2(left.y - belly.y, left.x - belly.x)
        let turn = { (a: CGFloat) in a - 2 * .pi * (a / (2 * .pi)).rounded(.down) }
        let growing = turn(base - from) < turn(to - from)
        path.addArc(center: belly, radius: r, startAngle: .radians(from), endAngle: .radians(to), clockwise: !growing)
        path.closeSubpath()
        return path
    }
}

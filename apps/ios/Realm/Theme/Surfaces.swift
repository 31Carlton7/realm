import SwiftUI
import UIKit

/// The radius ladder (design.md ▸ Shape) on the phone's continuous corner. A card in the transcript
/// sits inside a screen whose corners and bars are far rounder than a Mac window's, so it takes the
/// rung that reads as a card there, and a well inside it stays concentric: the card's radius is the
/// well's plus the padding between them.
enum Radius {
    /// A well inside a card: a command, a tool's output.
    static let well: CGFloat = 8
    /// The padding between a card's edge and a well inside it.
    static let cardPadding: CGFloat = 14
    /// A request, a run of tool calls, a fenced block, a table: panels the eye rests in.
    static let card: CGFloat = well + cardPadding
    /// What the person sent.
    static let bubble: CGFloat = 20
    /// The composer: a capsule while it holds one line, and the same curve as it grows.
    static let composer: CGFloat = 24
}

/// The grounds things stand on. Both faces keep one depth order — the ground, then a card a step
/// above it — and the light face takes the page's grey where the dark face takes the canvas, because a
/// white card on near-white paper measures no step at all.
enum Ground {
    /// Home and Settings: the grouped ground the lists' cards stand on.
    static let grouped = Palette.page
    /// The transcript.
    static let transcript = Color.dynamic(light: "Page", dark: "Canvas")
}

/// The fills Realm's own surfaces wear. They stay solid: glass belongs to the chrome that floats over
/// content, never to the content.
enum Fill {
    /// A card in the transcript, a row on Home.
    static let card = Palette.surface
    /// What the person sent: a step above the cards on the dark face, a grey bubble on the light one.
    static let bubble = Color.dynamic(light: "Hover2", dark: "Hover")
    /// A well inside a card, a step below it.
    static let well = Color.dynamic(light: "Page", dark: "Canvas")
}

extension Color {
    /// A colour that takes one palette entry in light and another in dark.
    static func dynamic(light: String, dark: String) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(named: traits.userInterfaceStyle == .dark ? dark : light, in: .main, compatibleWith: traits) ?? .clear
        })
    }

    /// `#rrggbb` or `#rgb`, as a space's colour is stored; nil for anything else.
    init?(hex: String) {
        guard let (red, green, blue) = Self.rgb(hex) else { return nil }
        self.init(.sRGB, red: red, green: green, blue: blue)
    }

    /// The channels of `#rrggbb` or `#rgb`, each 0…1.
    static func rgb(_ hex: String) -> (Double, Double, Double)? {
        var digits = hex.trimmingCharacters(in: .whitespaces)
        guard digits.hasPrefix("#") else { return nil }
        digits.removeFirst()
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        return (Double((value >> 16) & 255) / 255, Double((value >> 8) & 255) / 255, Double(value & 255) / 255)
    }
}

/// A space's colour as the desktop shows it (`spaceColor` in packages/ui/src/theme.ts): its hue, with
/// its lightness clamped to what reads on each face — 55 to 75 on the dark one, 35 to 55 on the light
/// one — and a saturation floor of 25 for a colour that has real chroma. A grey stays grey.
enum SpaceTint {
    /// `#rrggbb` for the face, from the stored `#rgb` or `#rrggbb`; nil for anything else.
    static func hex(_ stored: String, dark: Bool) -> String? {
        guard let rgb = Color.rgb(stored) else { return nil }
        var (h, s, l) = hsl(rgb)
        if s >= 8 { s = max(s, 25) }
        l = dark ? min(75, max(55, l)) : min(55, max(35, l))
        return hexString(fromHSL: h, s, l)
    }

    /// The colour for whichever face is showing.
    static func color(_ stored: String) -> Color? {
        guard let dark = hex(stored, dark: true), let light = hex(stored, dark: false),
              let darkColor = Color(hex: dark), let lightColor = Color(hex: light) else { return nil }
        let pair = (UIColor(darkColor), UIColor(lightColor))
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? pair.0 : pair.1 })
    }

    private static func hsl(_ rgb: (Double, Double, Double)) -> (Double, Double, Double) {
        let (r, g, b) = rgb
        let high = max(r, g, b), low = min(r, g, b)
        let l = (high + low) / 2
        guard high != low else { return (0, 0, l * 100) }
        let d = high - low
        let s = l > 0.5 ? d / (2 - high - low) : d / (high + low)
        var h: Double = high == r ? (g - b) / d + (g < b ? 6 : 0) : high == g ? (b - r) / d + 2 : (r - g) / d + 4
        h *= 60
        return (h, s * 100, l * 100)
    }

    private static func hexString(fromHSL h: Double, _ s: Double, _ l: Double) -> String {
        let saturation = s / 100, lightness = l / 100
        let a = saturation * min(lightness, 1 - lightness)
        func channel(_ n: Double) -> String {
            let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
            let value = lightness - a * max(-1, min(k - 3, min(9 - k, 1)))
            return String(format: "%02x", Int((value * 255).rounded()))
        }
        return "#\(channel(0))\(channel(8))\(channel(4))"
    }
}

extension View {
    /// Realm's own surface: a fill a step off the ground, no ring, the continuous corner.
    func surface(_ fill: Color = Fill.card, radius: CGFloat = Radius.card) -> some View {
        background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// At least 44 points to touch, whatever the glyph's size.
    func touchTarget() -> some View {
        frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }
}

/// A state's tone. Green, orange and red say state, never decoration, and always beside a word or a
/// glyph whose shape says it too.
enum Tone {
    case quiet, working, waiting, failed, done

    var color: Color {
        switch self {
        case .quiet: Palette.ink2
        case .working: Palette.accentInk
        case .waiting: Palette.orange
        case .failed: Palette.red
        case .done: Palette.green
        }
    }
}

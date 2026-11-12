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
    /// A photo or a file going with a message, in the composer's strip and under the message sent.
    static let thumbnail: CGFloat = 12
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

/// The fills Realm's own surfaces wear. They stay solid, and so does the chrome over them: the phone
/// draws no glass and no material anywhere.
enum Fill {
    /// A card in the transcript, a row on Home.
    static let card = Palette.surface
    /// What the person sent: a step above the cards on the dark face, a grey bubble on the light one.
    static let bubble = Color.dynamic(light: "Hover2", dark: "Hover")
    /// A well inside a card, a step below it.
    static let well = Color.dynamic(light: "Page", dark: "Canvas")
    /// A tool call's pill in the transcript, Manus's grey: the same step off the ground as what the
    /// person sent, since both are things set down in the reading rather than the reading itself.
    static let pill = bubble
    /// The one action, as Manus draws it: ink, not the accent — black on the light face, white on the
    /// dark — for Send, Stop and a filled choice.
    static let primary = Palette.ink
    /// A word or a glyph on `primary`: the paper it is printed on.
    static let onPrimary = Color.dynamic(light: "Surface", dark: "Page")
}

/// Manus's primary button: a capsule of ink with the paper's word on it, a shade lighter while pressed.
struct InkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        CapsuleLabel(configuration: configuration, fill: Fill.primary, ink: Fill.onPrimary)
    }
}

/// Its quieter neighbour, as Manus sets "Not now" beside "Approve": the pill's grey, the words in ink.
struct GreyButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        CapsuleLabel(configuration: configuration, fill: Fill.pill, ink: Palette.ink)
    }
}

/// A destructive step's button: the same capsule in the danger fill, with the white word it is solved for.
struct DangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        CapsuleLabel(configuration: configuration, fill: Palette.dangerFill, ink: .white)
    }
}

/// A chip over the composer — Review changes, a suggested reply, who is working: a card's capsule
/// lifted as the composer under it is, with the words in ink.
struct ChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(configuration.isPressed ? Palette.hover : Fill.card, in: Capsule())
            .floatingLift()
            .contentShape(Capsule())
    }
}

private struct CapsuleLabel: View {
    let configuration: ButtonStyleConfiguration
    let fill: Color
    let ink: Color
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(ink)
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .frame(minHeight: 48)
            .background(fill, in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : isEnabled ? 1 : 0.45)
            .contentShape(Capsule())
    }
}

extension View {
    /// The lift a floating card wears over the transcript — the composer, the current step — as Manus
    /// floats its own: a soft shadow and no edge.
    func floatingLift() -> some View {
        shadow(color: .black.opacity(0.08), radius: 14, y: 4)
    }
}

extension View {
    /// A bar over scrolling content, as Photos draws its own: what passes under it blurs softly and
    /// fades into the ground toward the screen's edge, so the bar's words stay legible with no band of
    /// glass or material behind them and no line where the content stops. Applied to the scroll view,
    /// inside any `safeAreaBar`, so the fade covers the bars' whole height.
    func softEdges(_ edges: Edge.Set = [.top, .bottom], ground: Color) -> some View {
        modifier(SoftEdges(edges: edges, ground: ground))
    }

    /// A list's pinned section head: Realm's ground behind it from edge to edge, and under it a fade
    /// deep enough that the line passing beneath has gone before it reaches the head's words. The
    /// 12-point fade it had let the top half of that line read through.
    func pinnedOnGround() -> some View {
        background(Ground.transcript)
            .background(alignment: .bottom) {
                LinearGradient(stops: [
                    .init(color: Ground.transcript, location: 0),
                    .init(color: Ground.transcript.opacity(0.97), location: 0.5),
                    .init(color: Ground.transcript.opacity(0.7), location: 0.8),
                    .init(color: Ground.transcript.opacity(0), location: 1),
                ], startPoint: .top, endPoint: .bottom)
                .frame(height: 28)
                .offset(y: 28)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
    }

    /// The way back from a pushed screen: the chevron on the bar's own ground, where iOS would draw it
    /// in a circle of glass, and the edge swipe as before.
    func backOnGround() -> some View {
        modifier(BackOnGround())
    }
}

/// The scroll edge's blur, and over it the ground deepening toward the screen's edge, as tall as the
/// bars the content scrolls under — the safe area there — and nothing where there is none. Not the
/// scroll view's content insets: a short transcript anchored to its foot pads those to the top.
private struct SoftEdges: ViewModifier {
    let edges: Edge.Set
    let ground: Color
    @State private var bars = EdgeInsets()

    /// How far past a bar the fade runs out, so the line just under the bar's words has already
    /// softened rather than reading through them.
    private static let overrun: CGFloat = 24

    func body(content: Content) -> some View {
        content
            .scrollEdgeEffectStyle(.soft, for: edges)
            .onGeometryChange(for: EdgeInsets.self, of: \.safeAreaInsets) { bars = $0 }
            .overlay {
                VStack(spacing: 0) {
                    if edges.contains(.top) {
                        fade(.top).frame(height: bars.top + Self.overrun)
                    }
                    Spacer(minLength: 0)
                    if edges.contains(.bottom) {
                        fade(.bottom).frame(height: bars.bottom + Self.overrun)
                    }
                }
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
    }

    private func fade(_ edge: VerticalEdge) -> LinearGradient {
        LinearGradient(stops: [
            .init(color: ground.opacity(0.95), location: 0),
            .init(color: ground.opacity(0.85), location: 0.6),
            .init(color: ground.opacity(0.55), location: 0.82),
            .init(color: ground.opacity(0), location: 1),
        ], startPoint: edge == .top ? .top : .bottom, endPoint: edge == .top ? .bottom : .top)
    }
}

private struct BackOnGround: ViewModifier {
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .navigationBarBackButtonHidden()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Back", systemImage: "chevron.backward") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
            }
            .background(SwipeBack().frame(width: 0, height: 0))
    }
}

/// A hidden back button takes the edge swipe with it. This hands the swipe back to the navigation
/// controller, for as long as there is a screen under the top one to go back to.
private struct SwipeBack: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) {}

    final class Probe: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            // The edge's swipe and, since iOS 26, the one from anywhere in the content.
            for gesture in [navigationController?.interactivePopGestureRecognizer,
                            navigationController?.interactiveContentPopGestureRecognizer] {
                gesture?.delegate = Pops.shared
            }
        }
    }

    final class Pops: NSObject, UIGestureRecognizerDelegate {
        static let shared = Pops()

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            ((gesture.view?.next as? UINavigationController)?.viewControllers.count ?? 0) > 1
        }
    }
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

    /// The column a line's leading glyph stands in, so the words beside it start together. It grows
    /// with the text size: a fixed column holds the glyph at the default size and lets it run into its
    /// word at the accessibility sizes.
    func glyphColumn(_ width: CGFloat, relativeTo style: Font.TextStyle = .footnote) -> some View {
        modifier(GlyphColumn(width: width, style: style))
    }

    /// At least 44 points to touch, whatever the glyph's size.
    func touchTarget() -> some View {
        frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }

    /// Never wider than the width it is offered. A row that cannot fit runs past its own edge instead
    /// of widening the column it stands in, which would shift every row beside it off the screen.
    func keepsToOfferedWidth() -> some View {
        OfferedWidth { self }
    }
}

/// Lays its content out in the width offered and reports no more than that width.
private struct OfferedWidth: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let size = content.sizeThatFits(proposal)
        guard let width = proposal.width else { return size }
        return CGSize(width: min(size.width, width), height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
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

    /// The colour an agent's state wears: a sub-agent's, a teammate's, a message to one. Amber is the
    /// only colour there, and only where it needs you or failed; working is said by its spinner, done
    /// and at rest by their glyph or nothing, all in the quiet ink.
    var agentColor: Color {
        switch self {
        case .waiting, .failed: Palette.orange
        case .quiet, .working, .done: Palette.ink2
        }
    }
}

private struct GlyphColumn: ViewModifier {
    @ScaledMetric private var width: CGFloat

    init(width: CGFloat, style: Font.TextStyle) {
        _width = ScaledMetric(wrappedValue: width, relativeTo: style)
    }

    func body(content: Content) -> some View {
        content.frame(width: width)
    }
}

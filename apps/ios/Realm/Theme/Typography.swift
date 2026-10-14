import SwiftUI
import UIKit

/// Realm's two families, as on the Mac: Inter for interface and reading, JetBrains Mono for code,
/// paths, models and machine state. They are bundled as TTF, because the desktop ships WOFF2 and iOS
/// cannot load it, and every size is a text style's, so Dynamic Type scales all of it. The transcript
/// reads at the system's body size: a phone in the hand is not a screen at arm's length.
enum RealmType {
    /// The desktop's weight ladder (tokens.css): routine labels 450–500, titles 560, strong 600. Inter
    /// is variable, so these are its exact weights rather than the nearest named face.
    enum Weight: CGFloat {
        case regular = 400
        case label = 450
        case medium = 500
        case title = 560
        case strong = 600
    }

    static let interName = "InterVariable"
    static let interItalicName = "InterVariableItalic"

    /// A text style's size at the default Dynamic Type setting.
    static func baseSize(_ style: UIFont.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title1: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption1: 12
        case .caption2: 11
        default: 17
        }
    }

    static func uiFont(_ style: UIFont.TextStyle, weight: Weight = .regular, italic: Bool = false, mono: Bool = false,
                       sizeCategory: UIContentSizeCategory = .large, boldText: Bool = false) -> UIFont {
        let traits = UITraitCollection(preferredContentSizeCategory: sizeCategory)
        let size = UIFontMetrics(forTextStyle: style).scaledValue(for: baseSize(style), compatibleWith: traits)
        if mono {
            let name = weight.rawValue >= Weight.medium.rawValue || boldText ? "JetBrainsMono-Medium" : "JetBrainsMono-Regular"
            return UIFont(name: name, size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        }
        // Bold Text asks every weight to step up, as the system's own fonts do.
        let wght = min(900, weight.rawValue + (boldText ? 150 : 0))
        let variations: [NSNumber: CGFloat] = [
            Self.axis("wght"): wght,
            // Optical size follows the point size, as `font-optical-sizing: auto` does on the Mac.
            Self.axis("opsz"): min(32, max(14, size)),
        ]
        let descriptor = UIFontDescriptor(name: italic ? interItalicName : interName, size: size)
            .addingAttributes([UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): variations])
        let font = UIFont(descriptor: descriptor, size: size)
        return font.familyName.hasPrefix("Inter") ? font : .systemFont(ofSize: size, weight: .regular)
    }

    static func font(_ style: UIFont.TextStyle, weight: Weight = .regular, italic: Bool = false, mono: Bool = false,
                     dynamicTypeSize: DynamicTypeSize, boldText: Bool) -> Font {
        Font(uiFont(style, weight: weight, italic: italic, mono: mono, sizeCategory: UIContentSizeCategory(dynamicTypeSize),
                    boldText: boldText) as CTFont)
    }

    /// An OpenType axis tag as Core Text names it: its four characters as one number.
    static func axis(_ tag: String) -> NSNumber {
        NSNumber(value: tag.unicodeScalars.reduce(UInt32(0)) { ($0 << 8) | $1.value })
    }

    /// Whether the bundled faces registered: what the launch checks before it trusts them.
    static var isInstalled: Bool {
        UIFont(name: interName, size: 17) != nil && UIFont(name: "JetBrainsMono-Regular", size: 17) != nil
    }
}

/// Sets a Realm font that follows Dynamic Type and Bold Text: it reads both from the environment, so
/// a change to either redraws it.
struct RealmFontModifier: ViewModifier {
    let style: UIFont.TextStyle
    let weight: RealmType.Weight
    let italic: Bool
    let mono: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight

    func body(content: Content) -> some View {
        content.font(RealmType.font(style, weight: weight, italic: italic, mono: mono, dynamicTypeSize: dynamicTypeSize,
                                    boldText: legibilityWeight == .bold))
    }
}

extension View {
    /// Inter at a text style's size.
    func inter(_ style: UIFont.TextStyle, _ weight: RealmType.Weight = .regular, italic: Bool = false) -> some View {
        modifier(RealmFontModifier(style: style, weight: weight, italic: italic, mono: false))
    }

    /// JetBrains Mono at a text style's size: code, paths, models, commands.
    func mono(_ style: UIFont.TextStyle, _ weight: RealmType.Weight = .regular) -> some View {
        modifier(RealmFontModifier(style: style, weight: weight, italic: false, mono: true))
    }
}

/// The fonts a view needs to build attributed text by hand, at the reader's Dynamic Type size.
struct RealmFonts {
    let dynamicTypeSize: DynamicTypeSize
    let boldText: Bool

    func inter(_ style: UIFont.TextStyle, _ weight: RealmType.Weight = .regular, italic: Bool = false) -> Font {
        RealmType.font(style, weight: weight, italic: italic, dynamicTypeSize: dynamicTypeSize, boldText: boldText)
    }

    func mono(_ style: UIFont.TextStyle, _ weight: RealmType.Weight = .regular) -> Font {
        RealmType.font(style, weight: weight, mono: true, dynamicTypeSize: dynamicTypeSize, boldText: boldText)
    }
}

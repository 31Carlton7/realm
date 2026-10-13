import SwiftUI
import UIKit

/// Realm's type on the iPhone. The interface and the reading are the system's own face, on its text
/// styles: the bars, menus, alerts, swipe actions and keyboard around every screen are drawn in it by
/// iOS, and a second sans beside them is two faces doing one job. The text styles also carry the
/// tracking and leading Apple tunes for every Dynamic Type size, which a bundled face scaled by
/// UIFontMetrics does not. Code, paths, commands, models and machine state keep JetBrains Mono, as on
/// the Mac: bundled as TTF (iOS cannot load the desktop's WOFF2) and set at a text style's size, so it
/// scales with everything else.
enum RealmType {
    static let monoName = "JetBrainsMono-Regular"
    static let monoMediumName = "JetBrainsMono-Medium"

    /// A text style's size at the default Dynamic Type setting: what a bundled face is drawn at
    /// before the system scales it with the style.
    static func baseSize(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 17
        }
    }

    /// JetBrains Mono at a text style's size, following Dynamic Type. Medium where Bold Text asks for
    /// heavier type, as the system's own faces step up.
    static func mono(_ style: Font.TextStyle, medium: Bool = false) -> Font {
        .custom(medium ? monoMediumName : monoName, size: baseSize(style), relativeTo: style)
    }

    /// Whether the bundled faces registered: what the launch checks before it trusts them.
    static var isInstalled: Bool {
        UIFont(name: monoName, size: 17) != nil && UIFont(name: monoMediumName, size: 17) != nil
    }
}

/// Sets JetBrains Mono at a text style's size. It reads Bold Text from the environment, so turning it
/// on redraws the run in Medium.
struct MonoFont: ViewModifier {
    let style: Font.TextStyle
    let medium: Bool
    @Environment(\.legibilityWeight) private var legibilityWeight

    func body(content: Content) -> some View {
        content.font(RealmType.mono(style, medium: medium || legibilityWeight == .bold))
    }
}

extension View {
    /// JetBrains Mono: code, paths, models, commands.
    func mono(_ style: Font.TextStyle, medium: Bool = false) -> some View {
        modifier(MonoFont(style: style, medium: medium))
    }
}

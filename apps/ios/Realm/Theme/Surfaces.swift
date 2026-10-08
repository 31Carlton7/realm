import RealmKit
import SwiftUI
import UIKit

/// The system's bars keep the system's material (Liquid Glass); only their titles take Realm's face.
enum Chrome {
    @MainActor static func apply() {
        let bar = UINavigationBar.appearance()
        bar.largeTitleTextAttributes = [.font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: RealmType.uiFont(.largeTitle, weight: .title))]
        bar.titleTextAttributes = [.font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: RealmType.uiFont(.headline, weight: .title))]
    }
}

/// The radius ladder (design.md ▸ Shape), on the system's continuous corner.
enum Radius {
    static let control: CGFloat = 8
    static let card: CGFloat = 12
    static let sheet: CGFloat = 16
    /// The composer and a fenced code block: panels the eye rests in.
    static let panel: CGFloat = 20
}

extension View {
    /// Realm's own surfaces stay solid: a fill a step off the ground, no ring, the continuous corner.
    func surface(_ fill: Color = Palette.surface, radius: CGFloat = Radius.card) -> some View {
        background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// At least 44 points to touch, whatever the glyph's size.
    func touchTarget() -> some View {
        frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }
}

/// A state's tone. Green, orange and red say state, never decoration, and always beside a word.
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

extension SessionStatus {
    var tone: Tone {
        switch self {
        case .running: .working
        case .waiting: .waiting
        case .error: .failed
        case .idle, .ended, .other: .quiet
        }
    }
}

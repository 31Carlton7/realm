import RealmKit
import SwiftUI

/// A session's status as a glyph whose SHAPE says it, in its tone: a hand that waits on you, a
/// triangle that failed, an indicator that runs. It always sits beside the status's word, which is
/// what VoiceOver reads, so the glyph itself is silent.
struct StatusGlyph: View {
    let status: SessionStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(systemName: Self.symbol(status))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(status.tone.color)
            .imageScale(status == .idle ? .small : .medium)
            // A run is live work, the one state worth motion. It holds still under Reduce Motion.
            .symbolEffect(.variableColor.iterative.dimInactiveLayers.nonReversing, options: .repeat(.continuous),
                          isActive: status == .running && !reduceMotion)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityHidden(true)
    }

    static func symbol(_ status: SessionStatus) -> String {
        switch status {
        case .running: "progress.indicator"
        case .waiting: "hand.raised.fill"
        case .error: "exclamationmark.triangle.fill"
        // The Mac's idle dot: nothing is happening, and nothing needs saying louder.
        case .idle: "circle.fill"
        case .ended: "stop.circle"
        case .other: "questionmark.circle"
        }
    }
}

/// An agent's mark, as the Mac's model chip draws it: the vendor's own glyph, in the ink of the text
/// beside it, or in the vendor's colour where the agent's identity is the point. An agent with no
/// mark on file draws nothing: a guessed mark would name the wrong vendor, and its name is beside it.
struct AgentMark: View {
    /// The agent's kind, as a session names it (`claude`, `codex`, `acp:gemini`).
    let kind: String
    var colored = false
    @ScaledMetric private var size: CGFloat

    init(kind: String, colored: Bool = false, size: CGFloat = 15, relativeTo style: Font.TextStyle = .subheadline) {
        self.kind = kind
        self.colored = colored
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }

    /// The asset that draws an agent's mark, if one is on file.
    static func asset(for kind: String) -> String? {
        Marks.agents[kind].map { "Agents/\($0)" }
    }

    var body: some View {
        if let asset = Self.asset(for: kind) {
            let image = Image(asset)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
            if let vendorColor {
                image.foregroundStyle(vendorColor)
            } else {
                image
            }
        }
    }

    /// The vendor's own colour, asked for and declared; otherwise the mark takes the text's ink.
    private var vendorColor: Color? {
        guard colored, let icon = Marks.agents[kind], let hex = Marks.agentColors[icon] else { return nil }
        return Color(hex: hex)
    }
}

/// What a space's icon is, read as the desktop reads it (`parseSpaceIcon` in presets.ts): an emoji, a
/// picture made for it, or one of the picker's glyphs — a bare name included, since that is every
/// icon stored before the prefixes existed. A glyph this phone does not have falls back to the folder,
/// as the desktop's does.
enum SpaceIcon: Equatable {
    case glyph(String)
    case emoji(String)
    /// A picture generated or uploaded for the space. The phone has no copy of it yet, so it wears the
    /// folder glyph in the space's colour.
    case picture(id: String)

    init(_ icon: String?) {
        guard let icon, !icon.isEmpty else {
            self = .glyph("folder")
            return
        }
        guard let colon = icon.firstIndex(of: ":") else {
            self = Self.known(icon)
            return
        }
        let kind = icon[..<colon]
        let rest = String(icon[icon.index(after: colon)...])
        if kind == "emoji", !rest.isEmpty {
            self = .emoji(rest)
        } else if kind == "asset", !rest.isEmpty {
            self = .picture(id: rest)
        } else {
            self = Self.known(kind == "hugeicon" ? rest : icon)
        }
    }

    private static func known(_ name: String) -> SpaceIcon {
        .glyph(Marks.spaces.contains(name) ? name : "folder")
    }

    /// The catalog image this icon draws, when it is a glyph.
    var asset: String? {
        switch self {
        case .glyph(let name): "Spaces/\(name)"
        case .picture: "Spaces/folder"
        case .emoji: nil
        }
    }
}

/// A space's glyph in the space's colour, or its emoji as it is: what the sidebar shows beside the
/// space's name on the Mac.
struct SpaceGlyph: View {
    let icon: SpaceIcon
    let color: Color?
    @ScaledMetric private var size: CGFloat

    init(icon: String?, color: String?, size: CGFloat = 18, relativeTo style: Font.TextStyle = .subheadline) {
        self.icon = SpaceIcon(icon)
        self.color = color.flatMap(SpaceTint.color)
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }

    init(space: Space, size: CGFloat = 18, relativeTo style: Font.TextStyle = .subheadline) {
        self.init(icon: space.icon?.stringValue, color: space.color?.stringValue, size: size, relativeTo: style)
    }

    var body: some View {
        Group {
            switch icon {
            case .emoji(let emoji):
                Text(emoji)
                    .font(.system(size: size * 0.9))
            case .glyph, .picture:
                Image(icon.asset ?? "Spaces/folder")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(color ?? Palette.ink2)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

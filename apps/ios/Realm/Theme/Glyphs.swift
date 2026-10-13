import RealmKit
import SwiftUI

extension View {
    /// A glyph that says work began: its segments light a few times in turn, then it holds its still
    /// form, which says the same thing (design.md ▸ Motion). It plays again when the state is drawn
    /// anew, and not at all under Reduce Motion.
    func restingPulse(when active: Bool) -> some View {
        modifier(RestingPulse(active: active))
    }
}

private struct RestingPulse: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var plays = 0

    func body(content: Content) -> some View {
        content
            .symbolEffect(.variableColor.iterative.dimInactiveLayers.nonReversing, options: .repeat(3), value: plays)
            .onAppear { if active && !reduceMotion { plays += 1 } }
            .onChange(of: active) { _, now in if now && !reduceMotion { plays += 1 } }
    }
}

/// How the link to the Mac looks beside its words: a shape for each state, and a tone that is only
/// ever a state's — green connected, red where something failed, quiet otherwise.
extension LinkStatus.Kind {
    var glyph: String {
        switch self {
        case .connected: "circle.fill"
        case .connecting: "circle.dotted"
        case .asleep: "moon.fill"
        case .notAnswering: "laptopcomputer.trianglebadge.exclamationmark"
        case .relayUnreachable: "wifi.exclamationmark"
        case .refused: "xmark.octagon.fill"
        case .notConnected: "pause.circle.fill"
        }
    }

    var tone: Tone {
        switch self {
        case .connected: .done
        case .notAnswering, .relayUnreachable, .refused: .failed
        case .connecting, .asleep, .notConnected: .quiet
        }
    }
}

/// An agent's mark, as the Mac's model chip draws it: the vendor's own glyph, in the ink of the text
/// beside it, or in the vendor's colour where the agent's identity is the point. The mark is the one
/// the Mac names for the session (`agentMark`), else the one this app's table has for its kind. An
/// agent with no mark on file draws nothing: a guessed mark would name the wrong vendor, and its name
/// is beside it.
struct AgentMark: View {
    let icon: String?
    var colored = false
    @ScaledMetric private var size: CGFloat

    init(kind: String, mark: String? = nil, colored: Bool = false, size: CGFloat = 15, relativeTo style: Font.TextStyle = .subheadline) {
        icon = Self.icon(kind: kind, mark: mark)
        self.colored = colored
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }

    /// The catalog's name for an agent's mark: the Mac's when it sent one the catalog holds.
    static func icon(kind: String, mark: String?) -> String? {
        if let mark, Marks.agentIcons.contains(mark) { return mark }
        return Marks.agents[kind]
    }

    /// The asset that draws an agent's mark, if one is on file.
    static func asset(kind: String, mark: String? = nil) -> String? {
        icon(kind: kind, mark: mark).map { "Agents/\($0)" }
    }

    var body: some View {
        if let icon {
            let image = Image("Agents/\(icon)")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
            if colored, let hex = Marks.agentColors[icon], let vendor = Color(hex: hex) {
                image.foregroundStyle(vendor)
            } else {
                image
            }
        }
    }
}

/// What a space's icon is, read as the desktop reads it: one of the picker's glyphs, an emoji, or a
/// picture made for it. A Mac that says which (`iconKind`) is taken at its word; for one that sends only
/// the stored string, the string is parsed as `parseSpaceIcon` in presets.ts does — a bare name is a
/// glyph, since that is every icon stored before the prefixes existed. A glyph this phone does not
/// have falls back to the folder, as the desktop's does.
enum SpaceIcon: Equatable {
    case glyph(String)
    case emoji(String)
    /// The person's own picture, which `space.icon` sends.
    case picture

    init(space: Space) {
        switch space.iconKind {
        case .glyph?: self = Self.known(space.glyph ?? "folder")
        case .emoji?: self = space.emoji.map(SpaceIcon.emoji) ?? .glyph("folder")
        case .picture?: self = .picture
        case .other?, nil: self.init(space.icon?.stringValue)
        }
    }

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
        } else if kind == "asset" {
            // A picture a Mac that sends no `iconKind` cannot send either.
            self = .glyph("folder")
        } else {
            self = Self.known(kind == "hugeicon" ? rest : icon)
        }
    }

    private static func known(_ name: String) -> SpaceIcon {
        .glyph(Marks.spaces.contains(name) ? name : "folder")
    }

    /// The catalog image this icon draws, or stands in with until its picture arrives.
    var asset: String? {
        switch self {
        case .glyph(let name): "Spaces/\(name)"
        case .picture: "Spaces/folder"
        case .emoji: nil
        }
    }
}

/// A space's glyph in the space's colour, its emoji as it is, or its picture: what the sidebar shows
/// beside the space's name on the Mac.
struct SpaceGlyph: View {
    let spaceId: String
    let icon: SpaceIcon
    let color: Color?
    @ScaledMetric private var size: CGFloat
    @Environment(AppModel.self) private var model

    init(space: Space, size: CGFloat = 18, relativeTo style: Font.TextStyle = .subheadline) {
        spaceId = space.id
        icon = SpaceIcon(space: space)
        color = space.color?.stringValue.flatMap(SpaceTint.color)
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }

    var body: some View {
        Group {
            switch icon {
            case .emoji(let emoji):
                Text(emoji)
                    .font(.system(size: size * 0.9))
            case .picture:
                if let picture = model.spacePictures[spaceId] {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFill()
                        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
                } else {
                    glyph("Spaces/folder")
                        .task(id: spaceId) { await model.loadSpacePicture(spaceId) }
                }
            case .glyph:
                glyph(icon.asset ?? "Spaces/folder")
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func glyph(_ asset: String) -> some View {
        Image(asset)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(color ?? Palette.ink2)
    }
}

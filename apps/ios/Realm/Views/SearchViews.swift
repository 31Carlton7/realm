import RealmKit
import SwiftUI

/// What the Mac's search found for some words.
struct FoundSessions: Equatable {
    let query: String
    let hits: [SearchHit]

    /// How long the typing rests before the words go to the Mac. Longer than the desktop palette's
    /// 120 ms: each ask crosses the relay.
    static let restsFor = Duration.milliseconds(250)
}

/// What Home asks the Mac's search: the words, in the profile it shows.
struct SearchAsk: Equatable {
    let query: String?
    let choice: ProfileChoice
}

/// The sessions the Mac's search found, best first, as the palette lists them: each once, with its
/// title and the words of the message that matched.
struct SearchHitsSection: View {
    let found: FoundSessions
    let home: Home

    var body: some View {
        let spaces = Dictionary(home.spaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        Section {
            ForEach(found.hits) { hit in
                SearchHitLink(hit: hit, space: spaces[hit.session.spaceId])
            }
        } header: {
            SectionHead(title: found.hits.count == 1 ? "1 session" : "\(found.hits.count) sessions") {
                Image(systemName: "magnifyingglass").foregroundStyle(Palette.ink2)
            }
        }
    }
}

/// A session the search found: opens it at the message that matched, which is shown as it opens.
private struct SearchHitLink: View {
    let hit: SearchHit
    let space: Space?
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            model.searchMatches[hit.session.id] = hit.message?.seq
            model.path.append(.session(hit.session.id))
        } label: {
            SearchHitRow(hit: hit, space: space)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("search-hit-\(hit.session.id)")
    }
}

/// The title, with what matched marked where it matched, and its age; the words around the match in
/// what was said; then where it is: its space, and the agent's mark and name.
struct SearchHitRow: View {
    let hit: SearchHit
    let space: Space?

    var body: some View {
        let row = hit.session
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    if let title = hit.title {
                        Text(Snippet.marked(title, ink: Palette.ink))
                    } else {
                        Text(row.displayTitle)
                    }
                }
                .font(.body.weight(.medium))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(Ago.text(row.lastActivity, now: context.date))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Palette.ink3)
                }
                .fixedSize()
            }
            if let message = hit.message {
                Text(Snippet.marked(message.snippet, ink: Palette.ink))
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(2)
            }
            HStack(spacing: 6) {
                if let space {
                    HStack(spacing: 4) {
                        SpaceGlyph(space: space, size: 13, relativeTo: .footnote)
                        Text(space.name)
                            .lineLimit(1)
                    }
                    .layoutPriority(1)
                    Text("·")
                        .accessibilityHidden(true)
                }
                HStack(spacing: 4) {
                    AgentMark(kind: row.agent, mark: row.agentMark, size: 12, relativeTo: .footnote)
                    Text(row.agentDisplayName)
                        .lineLimit(1)
                }
            }
            .font(.footnote)
            .foregroundStyle(Palette.ink2)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.spoken(hit))
        .accessibilityHint("Opens the session at what matched")
    }

    static func spoken(_ hit: SearchHit, now: Date = Date()) -> String {
        var parts = [hit.session.displayTitle]
        if let message = hit.message { parts.append(Snippet.plain(message.snippet)) }
        parts.append(contentsOf: [hit.session.spaceName, hit.session.agentDisplayName].filter { !$0.isEmpty })
        parts.append(Ago.text(hit.session.lastActivity, now: now))
        return parts.joined(separator: ", ")
    }
}

/// A search's snippet as text: what matched in the ink, on the accent's wash, as a selection is marked;
/// the rest in the line's own colour. A message's lines run together, so two lines hold the most words.
enum Snippet {
    static func marked(_ runs: [SnippetRun], ink: Color) -> AttributedString {
        var text = AttributedString()
        for run in runs {
            var part = AttributedString(oneLine(run.text))
            if run.match {
                part.foregroundColor = ink
                part.backgroundColor = Palette.accentTint
                part.inlinePresentationIntent = .stronglyEmphasized
            }
            text += part
        }
        return text
    }

    static func plain(_ runs: [SnippetRun]) -> String {
        oneLine(runs.map(\.text).joined())
    }

    private static func oneLine(_ text: String) -> String {
        String(text.map { $0.isNewline ? " " : $0 })
    }
}

/// Over the composer while a find in the session is open: where the match shown stands among those in
/// the rows here, and the way to the one before and after. Before the oldest, where the Mac has
/// earlier messages, it asks for them.
struct FindBar: View {
    let place: FindPlace
    let older: () -> Void
    let newer: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(place.words)
                .font(.subheadline.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(Palette.ink2)
                .padding(.leading, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("find-place")
            Button(action: older) {
                Image(systemName: "chevron.up")
                    .frame(width: 44, height: 44)
            }
            .disabled(!place.hasOlder)
            .accessibilityLabel(place.olderIsOnMac ? "Search earlier messages" : "Previous match")
            .accessibilityIdentifier("find-older")
            Button(action: newer) {
                Image(systemName: "chevron.down")
                    .frame(width: 44, height: 44)
            }
            .disabled(!place.hasNewer)
            .accessibilityLabel("Next match")
            .accessibilityIdentifier("find-newer")
        }
        .font(.body.weight(.semibold))
        .foregroundStyle(Palette.ink)
        .padding(.trailing, 4)
        .glassEffect(.regular, in: Capsule())
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }
}

/// Where a find in the session stands: the matches in the rows here, oldest first, by row key, the one
/// shown, and whether the Mac has earlier rows than these.
struct FindPlace: Equatable {
    let keys: [String]
    let current: String?
    let macHasEarlier: Bool
    /// The Mac is being asked for its earlier rows.
    var asking = false

    var index: Int? { current.flatMap { keys.firstIndex(of: $0) } }

    var hasNewer: Bool { index.map { $0 < keys.count - 1 } ?? false }
    /// The match before is here, or may be in the rows the Mac has not sent.
    var hasOlder: Bool { !asking && ((index ?? 0) > 0 || macHasEarlier) }
    var olderIsOnMac: Bool { (index ?? 0) == 0 && macHasEarlier }

    var words: String {
        if asking { return "Searching earlier messages…" }
        guard let index else { return macHasEarlier ? "Not in these messages" : "No matches" }
        return "\(index + 1) of \(keys.count)"
    }

    /// The match a step goes to, or nil where there is none here.
    func step(older: Bool) -> String? {
        guard let index else { return keys.last }
        let next = older ? index - 1 : index + 1
        return keys.indices.contains(next) ? keys[next] : nil
    }
}

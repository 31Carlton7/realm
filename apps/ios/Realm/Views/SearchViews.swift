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

/// The message a search result opens its session at, and the words that found it.
struct SearchMatch: Equatable {
    let seq: Int
    let words: String
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
        // With no hits, Home's empty state says so, and a head counting none would say it twice.
        if !found.hits.isEmpty {
            Section {
                ForEach(found.hits) { hit in
                    SearchHitLink(hit: hit, words: found.query, space: spaces[hit.session.spaceId])
                }
            } header: {
                SectionHead(title: found.hits.count == 1 ? "1 session" : "\(found.hits.count) sessions") {
                    Image(systemName: "magnifyingglass").foregroundStyle(Palette.ink2)
                }
            }
        }
    }
}

/// A session the search found: opens it at the message that matched, which is shown as it opens.
private struct SearchHitLink: View {
    let hit: SearchHit
    let words: String
    let space: Space?
    @Environment(AppModel.self) private var model
    @Environment(\.dismissSearch) private var dismissSearch

    var body: some View {
        Button {
            // Pushed over a search still under way, the session comes back to a Home with neither its
            // bar nor the field, and no way out. Put away first, it comes back to Home as it was.
            dismissSearch()
            model.searchMatches[hit.session.id] = hit.message.map { SearchMatch(seq: $0.seq, words: words) }
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

/// A search's snippet as text: what matched in the ink on the find's quiet tint, the rest in the
/// line's own colour. A message's lines run together, so two lines hold the most words.
enum Snippet {
    static func marked(_ runs: [SnippetRun], ink: Color) -> AttributedString {
        var text = AttributedString()
        for run in runs {
            var part = AttributedString(oneLine(run.text))
            if run.match {
                part.foregroundColor = ink
                part.backgroundColor = FindMark.tint(current: false)
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

/// The words a find or a search marks in a message: each place they appear takes a soft tint of the
/// ink behind it, and the match the find stands on a step more. Only the words, never the message:
/// the accent is not a wash.
struct FindMark: Equatable {
    /// What is marked: a find's words as one run, as it matches them; a search's each on its own, as
    /// the Mac's index matches them.
    let needles: [String]
    let current: Bool

    static func find(_ words: String, current: Bool) -> FindMark {
        FindMark(needles: [words.trimmingCharacters(in: .whitespacesAndNewlines)].filter { !$0.isEmpty }, current: current)
    }

    static func search(_ words: String) -> FindMark {
        FindMark(needles: words.split(whereSeparator: \.isWhitespace).map(String.init), current: true)
    }

    static func tint(current: Bool) -> Color {
        Palette.ink.opacity(current ? 0.2 : 0.09)
    }

    /// The text with every place the words appear tinted, case and accents ignored as the find's
    /// matching ignores them.
    func marked(_ text: AttributedString) -> AttributedString {
        var text = text
        for needle in needles {
            var from = text.startIndex
            while let found = text[from...].range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) {
                text[found].backgroundColor = Self.tint(current: current)
                from = found.upperBound
            }
        }
        return text
    }
}

extension EnvironmentValues {
    /// The words marked in the prose and bubbles below, while a find is open or a search has just
    /// opened the session at a match.
    @Entry var findMark: FindMark?
}

/// The session's foot while a find is open, in the composer's place, as Safari's find on page sits
/// over the keyboard: the field with where the match shown stands and the way to the one before and
/// after, then Done. Before the oldest, where the Mac has earlier messages, the step up asks for them.
struct FindBar: View {
    @Binding var query: String
    let place: FindPlace
    let older: () -> Void
    let newer: () -> Void
    let done: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let typed = !query.trimmingCharacters(in: .whitespaces).isEmpty
        HStack(spacing: 8) {
            HStack(spacing: 0) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Palette.ink2)
                    .padding(.trailing, 6)
                    .accessibilityHidden(true)
                TextField("Find in session", text: $query)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    // Return goes on up the session, as the find starts from its foot.
                    .onSubmit {
                        if place.hasOlder { older() }
                        focused = true
                    }
                    .foregroundStyle(Palette.ink)
                    .accessibilityIdentifier("find-field")
                if typed {
                    Text(place.words)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.leading, 6)
                        .accessibilityIdentifier("find-place")
                    Button(action: older) {
                        Image(systemName: "chevron.up")
                            .frame(width: 40, height: 44)
                    }
                    .disabled(!place.hasOlder)
                    .accessibilityLabel(place.olderIsOnMac ? "Search earlier messages" : "Previous match")
                    .accessibilityIdentifier("find-older")
                    Button(action: newer) {
                        Image(systemName: "chevron.down")
                            .frame(width: 40, height: 44)
                    }
                    .disabled(!place.hasNewer)
                    .accessibilityLabel("Next match")
                    .accessibilityIdentifier("find-newer")
                }
            }
            .font(.body)
            .tint(Palette.ink)
            .padding(.leading, 14)
            .padding(.trailing, typed ? 2 : 14)
            .frame(minHeight: 48)
            .background(Fill.card, in: Capsule())
            .floatingLift()
            Button("Done", action: done)
                .font(.body.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .frame(minHeight: 48)
                .padding(.horizontal, 16)
                .background(Fill.card, in: Capsule())
                .floatingLift()
                .accessibilityIdentifier("find-done")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .onAppear { focused = true }
    }
}

/// A find in the session, from its menu until Done: the words, the match it stands on, and whether
/// the Mac is being asked for its earlier rows. While it is open the foot is its bar alone.
struct FindState: Equatable {
    private(set) var isOpen = false
    var query = ""
    var current: String?
    var asking = false

    /// The composer and the press for the newest row, which the find's bar stands in for.
    var showsComposer: Bool { !isOpen }

    mutating func open() {
        isOpen = true
    }

    /// Done: the words go with it, so the next find starts empty.
    mutating func close() {
        self = FindState()
    }

    /// New words start at the newest match, as a find in Messages starts from the foot.
    mutating func typed(matching keys: [String]) {
        current = keys.last
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
        if asking { return "Searching…" }
        guard let index else { return macHasEarlier ? "None here" : "No matches" }
        return "\(index + 1) of \(keys.count)"
    }

    /// The match a step goes to, or nil where there is none here.
    func step(older: Bool) -> String? {
        guard let index else { return keys.last }
        let next = older ? index - 1 : index + 1
        return keys.indices.contains(next) ? keys[next] : nil
    }
}

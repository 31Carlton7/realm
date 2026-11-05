import Foundation

/// A run of a search's words: the part it matched, or the words around it. A snippet is the runs in
/// order, which join into the words, so nothing in a transcript can be mistaken for a marker.
public struct SnippetRun: Codable, Sendable, Hashable {
    public let text: String
    public let match: Bool

    public init(text: String, match: Bool) {
        self.text = text
        self.match = match
    }
}

/// A session `search.query` found: by its title, by something said in it, or both.
public struct SearchHit: Codable, Sendable, Hashable, Identifiable {
    public let session: SessionRow
    /// The title with the match marked, where the title matched.
    public let title: [SnippetRun]?
    /// The best-matching message, where something said matched.
    public let message: SearchMessage?

    public var id: String { session.id }

    public init(session: SessionRow, title: [SnippetRun]?, message: SearchMessage?) {
        self.session = session
        self.title = title
        self.message = message
    }
}

/// A message a search matched: its row's `seq`, which `session.open` reaches back to, and the words
/// around the match.
public struct SearchMessage: Codable, Sendable, Hashable {
    public let seq: Int
    public let snippet: [SnippetRun]

    public init(seq: Int, snippet: [SnippetRun]) {
        self.seq = seq
        self.snippet = snippet
    }
}

/// `search.query`
public struct SearchResults: Codable, Sendable, Hashable {
    public let hits: [SearchHit]

    public init(hits: [SearchHit]) {
        self.hits = hits
    }
}

/// What a search box sends the Mac: the words trimmed, and nothing under two characters, which match
/// everything and help no one, as the desktop's palette holds.
public enum SearchQuery {
    public static let shortest = 2
    public static let longest = 256

    public static func sent(_ typed: String) -> String? {
        let words = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard words.count >= shortest else { return nil }
        return String(words.prefix(longest))
    }
}

extension Transcript {
    /// The row a search's match is in: the one of its `seq`, or, where that row has since taken a later
    /// seq, the first said row with a later one. Nil where the match is further back than these rows.
    public func rowKey(matching seq: Int) -> String? {
        if let exact = rows.first(where: { $0.seq == seq && $0.isSaid }) { return exact.key }
        guard let first = rows.first(where: \.isSaid), first.seq <= seq || !hasMore else { return nil }
        return rows.first { $0.isSaid && $0.seq >= seq }?.key
    }

    /// The said rows that hold these words, oldest first, by key: what a find in the session steps
    /// through. Case and accents are ignored, as the desktop's search ignores them.
    public func keys(saying words: String) -> [String] {
        let needle = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        return rows.filter { row in
            guard let text = row.saidText else { return false }
            return text.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }.map(\.key)
    }
}

extension TranscriptRow {
    /// What the person or the agent said in this row, which search reads; nil for every other row.
    public var saidText: String? {
        switch content {
        case .user(let text): text
        case .assistant(let text, _): text
        default: nil
        }
    }

    var isSaid: Bool { saidText != nil }
}

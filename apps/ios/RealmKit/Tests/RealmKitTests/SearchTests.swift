import Foundation
@testable import RealmKit
import Testing

@Suite("Search")
struct SearchTests {
    static func said(_ seq: Int, _ text: String, assistant: Bool = false) -> TranscriptRow {
        TranscriptRow(key: assistant ? "m:\(seq)" : "u:\(seq)", seq: seq,
                      content: assistant ? .assistant(text: text, streaming: false) : .user(text: text))
    }

    static func tool(_ key: String, seq: Int) -> TranscriptRow {
        TranscriptRow(key: key, seq: seq, content: .tool(name: "Bash", summary: "grep pelican", state: .done, detail: "pelican"))
    }

    @Test(.enabled(if: APIFixtureTests.available, "ts-api.json is not written yet (the server's suite writes it)"))
    func decodesTheMacsHitsWithTheirRowsTitlesAndMessages() throws {
        let every = try APIFixtureTests.decode(SearchResults.self, "calls", "search.query")
        #expect(every.hits.map(\.session.title) == ["Theme column", "Ship 2.0.3", "Lecture notes"])
        let first = try #require(every.hits.first)
        #expect(first.title == [SnippetRun(text: "Theme", match: true), SnippetRun(text: " column", match: false)])
        #expect(first.message?.seq == 3)
        #expect(first.message?.snippet.filter(\.match).map(\.text) == ["theme"])
        #expect(first.session.spaceName == "Realm")
        #expect(first.session.agentMark == "claude")
        #expect(every.hits[1].title == nil)
        let one = try APIFixtureTests.decode(SearchResults.self, "calls", "search.query:profile")
        #expect(one.hits.map(\.session.spaceName) == ["Realm", "Realm"])
    }

    @Test func sendsTheWordsTrimmedFromTwoCharacters() {
        #expect(SearchQuery.sent(" p ") == nil)
        #expect(SearchQuery.sent("  pe ") == "pe")
        #expect(SearchQuery.sent(String(repeating: "a", count: 300))?.count == 256)
    }

    @Test func findsTheRowOfAMatchBySeq() {
        var transcript = Transcript(rows: [Self.said(4, "first"), Self.tool("t:1", seq: 9), Self.said(6, "the pelican", assistant: true), Self.said(8, "next")])
        #expect(transcript.rowKey(matching: 6) == "m:6")
        // A tool row has no words a search reads, though it holds the seq.
        #expect(transcript.rowKey(matching: 9) == nil)
        // A row whose seq moved on: the first said row after the match.
        #expect(transcript.rowKey(matching: 5) == "m:6")
        // Further back than these rows, while the Mac has more.
        transcript.hasMore = true
        #expect(transcript.rowKey(matching: 2) == nil)
        transcript.hasMore = false
        #expect(transcript.rowKey(matching: 2) == "u:4")
    }

    @Test func findsTheSaidRowsThatHoldTheWordsOldestFirst() {
        let transcript = Transcript(rows: [
            Self.said(1, "Move the Pelican"), Self.tool("t:1", seq: 2), Self.said(3, "Done: pélican moved", assistant: true), Self.said(4, "thanks"),
        ])
        #expect(transcript.keys(saying: "pelican") == ["u:1", "m:3"])
        #expect(transcript.keys(saying: "  THANKS ") == ["u:4"])
        #expect(transcript.keys(saying: " ").isEmpty)
        #expect(transcript.keys(saying: "grep").isEmpty)
    }
}

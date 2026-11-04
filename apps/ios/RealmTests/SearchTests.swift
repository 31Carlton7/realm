import Foundation
import RealmKit
import SwiftUI
import Testing
@testable import Realm

@Suite("Search and find")
@MainActor
struct SearchViewTests {
    static func said(_ seq: Int, _ text: String) -> TranscriptRow {
        TranscriptRow(key: "u:\(seq)", seq: seq, content: .user(text: text))
    }

    static func answer(_ key: String, seq: Int, _ text: String) -> TranscriptRow {
        TranscriptRow(key: key, seq: seq, content: .assistant(text: text, streaming: false))
    }

    static func tool(_ key: String, seq: Int) -> TranscriptRow {
        TranscriptRow(key: key, seq: seq, content: .tool(name: "Bash", summary: "ls", state: .done, detail: nil))
    }

    @Test func marksOnlyWhatMatchedAndRunsTheLinesTogether() {
        let runs = [SnippetRun(text: "move the\n", match: false), SnippetRun(text: "pelican", match: true), SnippetRun(text: " north", match: false)]
        let text = Snippet.marked(runs, ink: .red)
        #expect(String(text.characters) == "move the pelican north")
        let marked = text.runs.filter { $0.backgroundColor != nil }.map { String(text[$0.range].characters) }
        #expect(marked == ["pelican"])
        #expect(text.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.count == 1)
        #expect(Snippet.plain(runs) == "move the pelican north")
    }

    @Test func findsTheItemAFoldedMatchIsDrawnIn() {
        // A finished turn: what was said, an answer on the way and a tool call fold, the last answer stands.
        let rows = [Self.said(1, "move the pelican"), Self.answer("m:a", seq: 2, "looking for the pelican"), Self.tool("t:1", seq: 3),
                    Self.answer("m:b", seq: 4, "moved it")]
        let items = TranscriptLayout.items(rows, settled: true)
        #expect(TranscriptLayout.itemId(holding: "u:1", in: items) == "u:1")
        #expect(TranscriptLayout.itemId(holding: "m:a", in: items) == "fold/m:a")
        #expect(TranscriptLayout.itemId(holding: "m:b", in: items) == "m:b")
        #expect(TranscriptLayout.itemId(holding: "gone", in: items) == nil)
    }

    @Test func stepsThroughMatchesFromTheNewest() {
        let keys = ["u:1", "m:3", "u:5"]
        let start = FindPlace(keys: keys, current: nil, macHasEarlier: false)
        #expect(start.step(older: true) == "u:5")
        let newest = FindPlace(keys: keys, current: "u:5", macHasEarlier: false)
        #expect(newest.words == "3 of 3")
        #expect(newest.step(older: true) == "m:3")
        #expect(newest.step(older: false) == nil)
        #expect(!newest.hasNewer)
        let oldest = FindPlace(keys: keys, current: "u:1", macHasEarlier: false)
        #expect(oldest.step(older: true) == nil)
        #expect(!oldest.hasOlder)
        #expect(oldest.hasNewer)
    }

    @Test func goesToTheMacBeforeTheOldestMatchHereWhereItHasEarlierRows() {
        let oldest = FindPlace(keys: ["u:1", "u:5"], current: "u:1", macHasEarlier: true)
        #expect(oldest.hasOlder)
        #expect(oldest.olderIsOnMac)
        #expect(oldest.step(older: true) == nil)
        #expect(!FindPlace(keys: ["u:1", "u:5"], current: "u:5", macHasEarlier: true).olderIsOnMac)
        let none = FindPlace(keys: [], current: nil, macHasEarlier: true)
        #expect(none.words == "Not in these messages")
        #expect(none.hasOlder)
        #expect(FindPlace(keys: [], current: nil, macHasEarlier: false).words == "No matches")
        let asking = FindPlace(keys: ["u:1"], current: "u:1", macHasEarlier: true, asking: true)
        #expect(!asking.hasOlder)
        #expect(asking.words == "Searching earlier messages…")
    }
}

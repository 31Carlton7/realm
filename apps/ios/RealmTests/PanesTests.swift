import RealmKit
import SwiftUI
import Testing
import UIKit
@testable import Realm

@MainActor
@Suite("Watching a session's browser and terminal panes", .serialized)
struct PanesTests {
    @Test func anAddressIsReadWithoutItsScheme() {
        #expect(PaneWords.address("http://localhost:4000/docs") == "localhost:4000/docs")
        #expect(PaneWords.address("https://example.com/") == "example.com")
        #expect(PaneWords.browserLine(BrowserPane(id: "b", name: "New tab", url: "", live: true)) == "New tab")
    }

    /// The sixteen are Realm's own in each face; the rest of the 256 are xterm's.
    @Test func aTerminalsColoursAreRealmsSixteenThenXtermsCube() {
        let red = TerminalColors.rgb(.indexed(1), dark: true)
        #expect(Int(red.0 * 255) == 0xED && Int(red.1 * 255) == 0x74 && Int(red.2 * 255) == 0x71)
        // The light face's red is its own, dark enough to read on a light ground.
        #expect(Int(TerminalColors.rgb(.indexed(1), dark: false).0 * 255) == 0xBC)
        let orange = TerminalColors.rgb(.indexed(214), dark: true)
        #expect([orange.0, orange.1, orange.2].map { Int($0 * 255) } == [255, 175, 0])
        #expect(Int(TerminalColors.rgb(.indexed(232), dark: true).0 * 255) == 8)
        #expect([TerminalColors.rgb(.rgb(0, 200, 120), dark: false).1].map { Int(($0 * 255).rounded()) } == [200])
    }

    /// A line keeps its colours on its own text, and a faint run is the faint ink.
    @Test func aLineIsStyledTextOfItsRuns() {
        var text = TerminalText()
        text.feed("\u{1B}[31merror\u{1B}[0m ok")
        let line = TerminalColors.attributed(text.lines[0], dark: true)
        #expect(String(line.characters) == "error ok")
        #expect(line.runs.count == 2)
    }

    /// The info sheet's Panes lists the space's browsers and terminals by their panes' names.
    @Test func theInfoSheetListsTheSpacesPanes() throws {
        let model = modelWithSession(status: .idle)
        model.sessionPanes["s1"] = SessionPanes(
            browsers: [BrowserPane(id: "b1", name: "Realm docs", url: "http://localhost:4000/docs", live: true)],
            terminals: [TerminalPane(id: "t1", name: "build", detail: "pnpm build", running: false)])
        let words = try Drawing.words(List { PanesSection(sessionId: "s1", opening: .constant(nil)) }.environment(model).frame(height: 300))
        #expect(words.contains("Panes") || words.contains("PANES"), "\(words)")
        #expect(words.contains("Realm docs"), "\(words)")
        #expect(words.contains("localhost:4000/docs"), "\(words)")
        #expect(words.contains("Not running"), "\(words)")
    }
}

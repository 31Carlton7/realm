import Foundation
@testable import RealmKit
import Testing

/// A terminal's output as the phone draws it. What must die: colours dropped or put on the wrong text,
/// a progress bar drawn as every frame of itself, an escape cut between two answers printed as text,
/// and output that grows without end on a phone left following a busy build.
@Suite("A terminal's output, as text")
struct TerminalTextTests {
    static func text(_ feeds: String...) -> TerminalText {
        var t = TerminalText()
        for f in feeds { t.feed(f) }
        return t
    }

    @Test func colouredOutputKeepsItsColoursOnItsOwnText() {
        let t = Self.text("\u{1B}[1;34mme@mac\u{1B}[0m % ls\r\n\u{1B}[31merror\u{1B}[0m \u{1B}[38;5;214mwarn\u{1B}[39m \u{1B}[38;2;0;200;120mok\u{1B}[0m\r\n")
        #expect(t.lines.map(\.text) == ["me@mac % ls", "error warn ok"])
        #expect(t.lines[0].runs == [TerminalRun("me@mac", TerminalStyle(foreground: .indexed(4), bold: true)), TerminalRun(" % ls")])
        #expect(t.lines[1].runs.map(\.style.foreground) == [.indexed(1), nil, .indexed(214), nil, .rgb(0, 200, 120)])
    }

    @Test func brightColoursAndBackgroundsAreTheirOwn() {
        let t = Self.text("\u{1B}[92;41mA\u{1B}[49;22;2mB\u{1B}[103mC")
        #expect(t.lines[0].runs.map(\.style) == [
            TerminalStyle(foreground: .indexed(10), background: .indexed(1)),
            TerminalStyle(foreground: .indexed(10), dim: true),
            TerminalStyle(foreground: .indexed(10), background: .indexed(11), dim: true),
        ])
    }

    /// A carriage return writes over the line, as a progress bar does: only its last frame is drawn.
    @Test func aProgressBarIsDrawnAsItsLastFrame() {
        let t = Self.text("[    ] 0%\r[==  ] 50%\r[====] 100%\r\ndone\n")
        #expect(t.lines.map(\.text) == ["[====] 100%", "done"])
        #expect(Self.text("abcdef\r\u{1B}[Kxy").lines.map(\.text) == ["xy"])
        #expect(Self.text("abc\u{08}\u{08}X").lines.map(\.text) == ["aXc"])
        #expect(Self.text("a\tb").lines.map(\.text) == ["a       b"])
    }

    /// An escape cut between two answers is joined, not printed.
    @Test func anEscapeCutBetweenTwoFeedsIsJoined() {
        let t = Self.text("plain \u{1B}[3", "2mgreen\u{1B}", "[0m after")
        #expect(t.lines.map(\.text) == ["plain green after"])
        #expect(t.lines[0].runs[1] == TerminalRun("green", TerminalStyle(foreground: .indexed(2))))
    }

    /// Titles, links and the cursor's moves are read past, and leave nothing behind.
    @Test func whatIsNotTextLeavesNothingBehind() {
        let t = Self.text("\u{1B}]0;title\u{07}\u{1B}]8;;https://x.dev\u{1B}\\link\u{1B}]8;;\u{1B}\\\u{1B}[?25l\u{1B}(Bdone\u{1B}[?25h")
        #expect(t.lines.map(\.text) == ["linkdone"])
    }

    @Test func clearingTheScreenStartsAgain() {
        var t = Self.text("old\r\nlines\r\n")
        let before = t.lines.map(\.id)
        t.feed("\u{1B}[H\u{1B}[2Jnew")
        #expect(t.lines.map(\.text) == ["new"])
        #expect(!before.contains(t.lines[0].id))
    }

    @Test func itKeepsAtMostItsLinesTheOldestGoingFirst() {
        var t = TerminalText(maxLines: 3)
        for i in 0..<10 { t.feed("line \(i)\r\n") }
        #expect(t.lines.map(\.text) == ["line 7", "line 8", "line 9"])
        // Each line keeps its id as the ones above it go.
        #expect(t.lines.map(\.id) == [7, 8, 9])
        t.reset()
        #expect(t.lines.isEmpty)
    }
}

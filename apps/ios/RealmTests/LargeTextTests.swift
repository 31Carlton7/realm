import RealmKit
import SwiftUI
import Testing
import UIKit
@testable import Realm

/// At the accessibility sizes the composer's chips, the request dock and Settings' rows keep every
/// word: a word clipped by an edge, cut by an ellipsis or pushed under a button is not read back.
@MainActor
@Suite("Large text keeps every word", .serialized)
struct LargeTextTests {
    static let sizes: [DynamicTypeSize] = [.accessibility3, .accessibility5]
    /// The composer's toolbar between `+` and Send on the smaller phone (402 points wide).
    static let toolbar: CGFloat = 274

    static func lineHeight(_ style: UIFont.TextStyle, _ size: UIContentSizeCategory) -> CGFloat {
        UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: size)).lineHeight
    }

    /// The drawn height of a view, without the padding the drawing puts round it.
    static func height(_ view: some View, width: CGFloat = 370, size: DynamicTypeSize) throws -> CGFloat {
        try Drawing.image(of: view, width: width, size: size).size.height - 32
    }

    static func question(_ text: String, options: [String]) -> TranscriptRow.Request {
        let question = Question(question: text, header: "Database", multiSelect: false,
                                options: options.map { QuestionOption(label: $0, description: nil) })
        return TranscriptRow.Request(requestId: "q1", tool: "AskUserQuestion", title: "", summary: "", state: .pending,
                                     questions: [question])
    }

    static func pending(_ request: TranscriptRow.Request, model: AppModel) throws -> PendingRequest {
        try #require(PendingRequest.first(in: model.store.transcript("s1"), outbox: model.store.outbox))
    }

    /// The model, the mode and where it runs each say their words at every size, wrapping onto rows
    /// rather than running under Send.
    @Test func theComposersChipsKeepTheirWords() throws {
        let chips = SettingChips(label: "Opus 5.5", kind: "claude", mark: "claude", options: SettingWordsTests.options("default"),
                                 busy: false, openSettings: {},
                                 place: PlaceChip(label: "Main checkout", symbol: "laptopcomputer", open: {})) { _, _ in }
        for size in Self.sizes {
            let words = try Drawing.words(chips, width: Self.toolbar, dark: false, size: size)
            #expect(words.contains("Opus 5.5") && words.contains("Ask each time") && words.contains("Main checkout"), "\(size): \(words)")
        }
    }

    /// Rows of chips: as many to a row as fit, and a chip wider than the row takes the row's width and
    /// wraps its words inside it.
    @Test func chipRowsWrapAndNeverRunWide() {
        let three = ChipRows {
            ForEach(0..<3, id: \.self) { _ in Color.gray.frame(width: 150, height: 44) }
        }
        let size = UIHostingController(rootView: three).sizeThatFits(in: CGSize(width: 370, height: 2_000))
        #expect(size == CGSize(width: 370, height: 88))
        let long = ChipRows {
            Text("Ask before each edit and each command, then run what was allowed").lineLimit(nil)
        }
        let wrapped = UIHostingController(rootView: long).sizeThatFits(in: CGSize(width: 200, height: 2_000))
        #expect(wrapped.width == 200)
        #expect(wrapped.height > 2 * UIFont.preferredFont(forTextStyle: .body).lineHeight, "\(wrapped)")
    }

    /// The chips over the composer: a suggested reply is whole at the accessibility sizes.
    @Test func aSuggestedReplyIsWhole() throws {
        let chips = FootChips(sessionId: "s1", checkpointId: nil, hint: "Run the whole suite again and tell me what failed") { _ in }
        let words = try Drawing.words(chips.environment(modelWithSession()), size: .accessibility5)
        #expect(words.contains("Run the whole") && words.contains("failed"), "\(words)")
    }

    /// A question asked on the dock, and its options, are whole at the largest size, however long.
    @Test func aOneTapQuestionIsWholeAtTheLargestSize() throws {
        let request = Self.question("Which database should the sync service use for the offline cache on the phone and the Mac?",
                                    options: ["Postgres on the Mac", "SQLite on the phone, synced to the Mac every night"])
        let model = modelWithSession(rows: [TranscriptRow(key: "r:q1", seq: 4, content: .request(request))])
        let dock = WaitingDock(pending: try Self.pending(request, model: model), sessionId: "s1", fold: {}).environment(model)
        let words = try Drawing.words(dock, size: .accessibility5)
        #expect(words.contains("phone and the Mac?"), "\(words)")
        #expect(words.contains("Postgres on the Mac") && words.contains("every night"), "\(words)")
        #expect(words.contains("Skip"), "\(words)")
    }

    /// Stacked, an answer button too long for the width wraps rather than ends in an ellipsis.
    @Test func aStackedAnswerButtonWraps() throws {
        let buttons = AnswerButtons(decline: "Skip", accept: "Continue answering", onDecline: {}, onAccept: {})
        let words = try Drawing.words(buttons, size: .accessibility5)
        #expect(words.contains("Continue") && words.contains("answering"), "\(words)")
    }

    /// Folded, the request still says who waits on you.
    @Test func aFoldedRequestSaysWhoWaits() throws {
        let request = Self.question("Which database?", options: ["Postgres"])
        let model = modelWithSession(rows: [TranscriptRow(key: "r:q1", seq: 4, content: .request(request))])
        let folded = FoldedRequest(pending: try Self.pending(request, model: model), sessionId: "s1", unfold: {}).environment(model)
        let words = try Drawing.words(folded, size: .accessibility5)
        #expect(words.contains("waiting on you"), "\(words)")
    }

    /// A pill grown taller by its words keeps its resting corner, so the words are inside its fill.
    @Test func aTallPillKeepsItsRestingCorner() {
        let path = PillShape(height: 48).path(in: CGRect(x: 0, y: 0, width: 300, height: 150))
        #expect(path.contains(CGPoint(x: 10, y: 10)))
        #expect(!path.contains(CGPoint(x: 2, y: 2)))
        let resting = PillShape(height: 48).path(in: CGRect(x: 0, y: 0, width: 300, height: 48))
        #expect(!resting.contains(CGPoint(x: 6, y: 6)), "at its resting height it is a capsule")
    }

    /// A page's row keeps its chevron on the name's line; what waits there goes under the name.
    @Test func aSettingsPageRowKeepsItsChevronOnTheNamesLine() throws {
        let line = Self.lineHeight(.body, .accessibilityExtraExtraExtraLarge)
        let usage = try Self.height(SettingsPageRow(page: .usage, note: nil), size: .accessibility5)
        #expect(usage < 1.5 * line, "one line, the chevron beside the name: \(usage) against \(line)")
        let review = SettingsPageRow(page: .reviews, note: "2 to review")
        #expect(try Self.height(review, size: .accessibility5) < 2.5 * line)
        let words = try Drawing.words(review, size: .accessibility5)
        #expect(words.contains("Review") && words.contains("2 to review"), "\(words)")
        #expect(try Drawing.words(review).contains("2 to review"))
    }

    /// The relay's host is whole at the accessibility sizes, not cut in its middle.
    @Test func theRelayHostIsWhole() throws {
        let words = try Drawing.words(RelayHost(host: "relay.realm-mobile.example.com"), size: .accessibility5)
        #expect(words.contains("realm-mobile") && words.contains("example.com"), "\(words)")
    }
}

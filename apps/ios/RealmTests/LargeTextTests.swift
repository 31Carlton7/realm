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
    /// The composer's chips at the accessibility sizes, on their own row across the card, on the smaller
    /// phone (402 points wide). Between `+` and Send they have 278.
    static let chipsRow: CGFloat = 358

    static func lineHeight(_ style: UIFont.TextStyle, _ size: UIContentSizeCategory) -> CGFloat {
        UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: size)).lineHeight
    }

    static func height(_ view: some View, width: CGFloat = 370, size: DynamicTypeSize) -> CGFloat {
        UIHostingController(rootView: view.dynamicTypeSize(size)).sizeThatFits(in: CGSize(width: width, height: 4_000)).height
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
            let words = try Drawing.words(chips, width: Self.chipsRow, dark: false, size: size)
            for word in ["Opus 5.5", "Ask each", "time", "Main", "checkout"] {
                #expect(words.contains(word), "\(size): \(word) in \(words)")
            }
        }
    }

    /// On their own row the chips take the card's width less its insets, and `+` and Send sit under them;
    /// in the toolbar they have what is left between the two.
    @Test func theChipsRowTakesTheCardsWidth() throws {
        final class Placed { var chips = CGRect.zero, primary = CGRect.zero }
        func layout(chipsRow: Bool) throws -> Placed {
            let placed = Placed()
            let composer = ComposerLayout(card: true, chipsRow: chipsRow) {
                Color.clear.frame(height: 40).layoutValue(key: ComposerPart.self, value: .field)
                Color.clear.layoutValue(key: ComposerPart.self, value: .add)
                Color.clear.frame(height: 120)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { placed.chips = $0 }
                    .layoutValue(key: ComposerPart.self, value: .chips)
                Color.clear
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { placed.primary = $0 }
                    .layoutValue(key: ComposerPart.self, value: .primary)
            }
            _ = try Drawing.image(of: composer, width: 378, size: .accessibility5)
            return placed
        }
        let own = try layout(chipsRow: true)
        #expect(own.chips.width == 358, "\(own.chips)")
        #expect(own.primary.minY >= own.chips.maxY, "Send under the chips: \(own.primary) \(own.chips)")
        #expect(try layout(chipsRow: false).chips.width == 278)
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

    /// Given less room than its words need, the dock keeps to the room and scrolls inside it rather than
    /// squeezing them into ellipses.
    @Test func aDockTallerThanItsRoomScrolls() throws {
        let request = Self.question("Which database should the sync service use for the offline cache on the phone and the Mac?",
                                    options: ["Postgres on the Mac", "SQLite on the phone, synced to the Mac every night", "DynamoDB global tables"])
        let model = modelWithSession(rows: [TranscriptRow(key: "r:q1", seq: 4, content: .request(request))])
        let dock = WaitingDock(pending: try Self.pending(request, model: model), sessionId: "s1", fold: {}).environment(model)
            .dynamicTypeSize(.accessibility5)
        let size = UIHostingController(rootView: dock).sizeThatFits(in: CGSize(width: 370, height: 500))
        #expect(size.height <= 500, "\(size)")
        let roomy = UIHostingController(rootView: dock).sizeThatFits(in: CGSize(width: 370, height: 4_000))
        #expect(roomy.height > 500, "with room it is as tall as its words: \(roomy)")
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
        #expect(words.contains("Claude is") && words.contains("on you"), "\(words)")
    }

    /// A pill whose words wrap keeps the corner it had at one line, so the words stay inside its fill.
    @Test func aWrappedPillKeepsItsOneLineCorner() {
        let path = PillShape(oneLine: 48).path(in: CGRect(x: 0, y: 0, width: 300, height: 150))
        #expect(path.contains(CGPoint(x: 10, y: 10)))
        #expect(!path.contains(CGPoint(x: 2, y: 2)))
        let oneLine = PillShape(oneLine: 48).path(in: CGRect(x: 0, y: 0, width: 300, height: 48))
        #expect(!oneLine.contains(CGPoint(x: 6, y: 6)), "on one line it is a capsule")
    }

    /// A page's row keeps its chevron on the name's line; what waits there goes under the name.
    @Test func aSettingsPageRowKeepsItsChevronOnTheNamesLine() throws {
        let line = Self.lineHeight(.body, .accessibilityExtraExtraExtraLarge)
        let usage = Self.height(SettingsPageRow(page: .usage, note: nil), size: .accessibility5)
        #expect(usage < 1.5 * line, "one line, the chevron beside the name: \(usage) against \(line)")
        let review = SettingsPageRow(page: .reviews, note: "2 to review")
        let words = try Drawing.words(review, size: .accessibility5)
        #expect(words.contains("Review") && words.contains("2 to review"), "\(words)")
        #expect(try Drawing.words(review).contains("2 to review"))
    }

    /// The relay's host is whole at the accessibility sizes, not cut in its middle.
    @Test func theRelayHostIsWhole() throws {
        let words = try Drawing.words(RelayHost(host: "relay.realm-mobile.example.com"), size: .accessibility5)
        #expect(words.contains("mobile") && words.contains("example"), "\(words)")
    }
}

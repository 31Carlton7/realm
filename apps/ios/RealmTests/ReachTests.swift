@testable import Realm
import RealmKit
import SwiftUI
import Testing

@MainActor
@Suite("A question answered on the dock", .serialized)
struct ReachTests {
    static let database = Question(question: "Which database should this use?", header: "Database", multiSelect: false,
                                   options: [QuestionOption(label: "SQLite", description: "One file"),
                                             QuestionOption(label: "Postgres", description: nil, value: "pg")],
                                   defaultAnswer: .one("pg"))

    static func request(_ questions: [Question]) -> TranscriptRow.Request {
        TranscriptRow.Request(requestId: "q1", tool: "AskUserQuestion", title: "", summary: "", state: .pending, questions: questions)
    }

    static func question(multiSelect: Bool = false, secret: Bool = false, kind: String? = nil, options: Int = 2) -> Question {
        Question(question: "Pick one", header: "", multiSelect: multiSelect,
                 options: (0..<options).map { QuestionOption(label: "Option \($0)", description: nil) }, secret: secret, kind: kind)
    }

    @Test func oneChoiceFromAFewOptionsIsAnsweredOnTheDock() {
        #expect(OneTapQuestion.of(Self.request([Self.database])) == Self.database)
        #expect(OneTapQuestion.of(Self.request([Self.question(options: 4)])) != nil)
        #expect(OneTapQuestion.of(Self.request([Self.question(kind: "confirm")])) != nil)
    }

    @Test func everyOtherQuestionOpensTheSheet() {
        #expect(OneTapQuestion.of(Self.request([Self.database, Self.question()])) == nil)
        #expect(OneTapQuestion.of(Self.request([Self.question(multiSelect: true)])) == nil)
        #expect(OneTapQuestion.of(Self.request([Self.question(secret: true)])) == nil)
        #expect(OneTapQuestion.of(Self.request([Self.question(kind: "file")])) == nil)
        #expect(OneTapQuestion.of(Self.request([Self.question(options: 0)])) == nil)
        #expect(OneTapQuestion.of(Self.request([Self.question(options: 5)])) == nil)
    }

    /// A tap is the whole answer: the option alone, under the question's key, as the sheet would send it.
    @Test func aTapSendsThatOption() {
        let request = Self.request([Self.database])
        let draft = OneTapQuestion.answer(Self.database.options[1], to: Self.database, of: request, in: "s1")
        #expect(draft.isComplete)
        #expect(draft.requestId == "q1" && draft.sessionId == "s1")
        #expect(draft.answers == ["Which database should this use?": "Postgres"])
        #expect(draft.values == ["Which database should this use?": .one("pg")])
    }

    @Test func theSuggestedOptionIsTheFilledOne() {
        #expect(OneTapQuestion.suggests(Self.database.options[1], in: Self.database))
        #expect(!OneTapQuestion.suggests(Self.database.options[0], in: Self.database))
    }

    @Test func theDockDrawsTheOptions() throws {
        let model = modelWithSession(rows: [TranscriptRow(key: "r:q1", seq: 4, content: .request(Self.request([Self.database])))])
        let pending = try #require(PendingRequest.first(in: model.store.transcript("s1"), outbox: model.store.outbox))
        let words = try Drawing.words(WaitingDock(pending: pending, sessionId: "s1", fold: {}).environment(model))
        #expect(words.contains("Which database should this use?"), "\(words)")
        #expect(words.contains("SQLite") && words.contains("Postgres"), "\(words)")
        #expect(words.contains("Skip") && words.contains("Other answer"), "\(words)")
        #expect(!words.contains("Answer "), "\(words)")
    }
}

import Foundation
@testable import RealmKit
import Testing

@Suite("Answering a question card")
struct AnswerDraftTests {
    static let database = Question(question: "Which database should this use?", header: "Database", multiSelect: false,
                                   options: [QuestionOption(label: "Postgres", description: "Relational"),
                                             QuestionOption(label: "SQLite", description: nil)])
    static let regions = Question(question: "Which regions?", header: "Regions", multiSelect: true,
                                  options: ["us-east-1", "eu-west-1", "ap-south-1"].map { QuestionOption(label: $0, description: nil) })
    static let fixed = Question(question: "Which region should it deploy to?", header: "Region", multiSelect: false,
                                options: [QuestionOption(label: "us-east-1", description: nil)], allowOther: false)
    static let words = Question(question: "Anything else?", header: "", multiSelect: false, options: [])

    static func draft(_ questions: [Question] = [database, regions]) -> AnswerDraft {
        AnswerDraft(sessionId: "s1", requestId: "r1", questions: questions)
    }

    @Test func aSingleChoiceReplacesTheLast() {
        var draft = Self.draft([Self.database])
        draft.toggle("Postgres", in: Self.database)
        draft.toggle("SQLite", in: Self.database)
        #expect(draft.answers == ["Which database should this use?": "SQLite"])
        draft.toggle("SQLite", in: Self.database)
        #expect(draft.answers.isEmpty, "picking the chosen option again clears it")
    }

    @Test func wordsOfTheirOwnStandInsteadOfAnOption() {
        var draft = Self.draft([Self.database])
        draft.toggle("Postgres", in: Self.database)
        draft.setOther("DuckDB, embedded", for: Self.database)
        #expect(draft.answers == ["Which database should this use?": "DuckDB, embedded"])
        draft.toggle("SQLite", in: Self.database)
        #expect(draft.answers == ["Which database should this use?": "SQLite"], "an option picked after clears the words")
    }

    @Test func aMultiSelectQuestionTakesSeveralInTheOptionsOrderThenTheirWords() {
        var draft = Self.draft([Self.regions])
        draft.toggle("ap-south-1", in: Self.regions)
        draft.toggle("us-east-1", in: Self.regions)
        draft.setOther("sa-east-1", for: Self.regions)
        #expect(draft.answers == ["Which regions?": "us-east-1, ap-south-1, sa-east-1"])
        draft.toggle("us-east-1", in: Self.regions)
        #expect(draft.answers == ["Which regions?": "ap-south-1, sa-east-1"])
    }

    @Test func aQuestionThatTakesNoWordsIgnoresThem() {
        var draft = Self.draft([Self.fixed])
        draft.setOther("eu-central-1", for: Self.fixed)
        #expect(draft.answers.isEmpty)
        #expect(!Self.fixed.takesText)
        #expect(Self.words.takesText, "a question with no options is answered in words")
    }

    @Test func itIsCompleteOnlyWhenEveryQuestionHasAnAnswer() {
        var draft = Self.draft([Self.database, Self.words])
        #expect(!draft.isComplete)
        draft.toggle("Postgres", in: Self.database)
        #expect(!draft.isComplete)
        draft.setOther("   ", for: Self.words)
        #expect(!draft.isComplete, "blank words are no answer")
        draft.setOther("Ship it Friday", for: Self.words)
        #expect(draft.isComplete)
    }

    /// Swiping the sheet away is a way out, never an answer.
    @MainActor
    @Test func puttingTheSheetAwayKeepsThePicksAndAnswersNothing() {
        let store = OutboxTests.openStore(rows: [TranscriptRow(key: "r:r1", seq: 5, content: .request(.init(
            requestId: "r1", tool: "AskUserQuestion", title: "Question", summary: "", state: .pending, questions: [Self.database])))])
        guard case .request(let request) = store.transcript("s1").rows[0].content else {
            Issue.record("no request row")
            return
        }
        var draft = store.draft(for: request, in: "s1")
        draft.toggle("SQLite", in: Self.database)
        #expect(draft.isComplete)
        store.keepDraft(draft)
        #expect(store.outbox.items.isEmpty)
        #expect(store.draft(for: request, in: "s1").answers == ["Which database should this use?": "SQLite"])

        let sent = store.submit(store.draft(for: request, in: "s1"))
        #expect(sent?.payload == .answer(requestId: "r1", decision: .allow, answers: ["Which database should this use?": "SQLite"]))
        #expect(store.outbox.items.count == 1)
        #expect(store.drafts["r1"] == nil)
    }

    @MainActor
    @Test func anIncompleteDraftCannotBeSent() {
        let store = OutboxTests.openStore()
        #expect(store.submit(Self.draft()) == nil)
        #expect(store.outbox.items.isEmpty)
    }
}

@MainActor
@Suite("Marking a session read")
struct SeenTests {
    @Test func itMarksForwardOnceForEachSeq() {
        let store = OutboxTests.openStore(rows: [OutboxTests.user("hello", seq: 4), StoreTests.row("m:a", "hi", seq: 6)])
        #expect(store.seenToMark("s1") == 6)
        store.markedSeen("s1", upTo: 6)
        #expect(store.seenToMark("s1") == nil)
        store.apply(.sessionRows(SessionRowsEvent(id: "s1", rows: [StoreTests.row("m:b", "more", seq: 9)])))
        #expect(store.seenToMark("s1") == 9)
        store.markedSeen("s1", upTo: 9)
        store.markedSeen("s1", upTo: 3)
        #expect(store.seenToMark("s1") == nil, "never backwards")
    }

    @Test func rowsFromTheCacheAreNotMarkedRead() {
        let store = RealmStore()
        store.restoreTranscript("s1", from: Cached(value: TranscriptSnapshot(session: nil, status: nil,
                                                                              rows: [StoreTests.row("m:a", "hi", seq: 6)], hasMore: false),
                                                   savedAt: Date()))
        #expect(store.seenToMark("s1") == nil)
        #expect(store.seenToMark("never-opened") == nil)
    }
}

@MainActor
@Suite("Shown at once, then fresh")
struct FreshnessTests {
    @Test func theCachedHomeShowsUntilTheMacSendsOne() throws {
        let store = RealmStore()
        let cached = try CacheTests.home()
        let savedAt = Date(timeIntervalSince1970: 1_790_000_000)
        store.restoreHome(Cached(value: cached, savedAt: savedAt))
        #expect(store.home == cached)
        #expect(store.homeSavedAt == savedAt)
        let live = Home(mac: MacInfo(name: "MacBook Pro"), needsYou: [], spaces: [])
        store.showHome(live)
        #expect(store.homeSavedAt == nil)
        // A cache read late never replaces what the Mac sent.
        store.restoreHome(Cached(value: cached, savedAt: savedAt))
        #expect(store.home == live)
        let dropped = Date(timeIntervalSince1970: 1_790_000_500)
        store.markStale(at: dropped)
        #expect(store.homeSavedAt == dropped)
    }

    @Test func aCachedSessionGivesWayToTheOpenedOne() {
        let store = RealmStore()
        let savedAt = Date(timeIntervalSince1970: 1_790_000_000)
        store.restoreTranscript("s1", from: Cached(value: TranscriptSnapshot(session: StoreTests.session("s1"), status: .idle,
                                                                              rows: [StoreTests.row("m:a", "old")], hasMore: false),
                                                   savedAt: savedAt))
        #expect(store.transcript("s1").savedAt == savedAt)
        #expect(!store.transcript("s1").isLive)
        store.beginOpening("s1")
        store.finishOpening(OpenedSession(session: StoreTests.session("s1"), rows: [StoreTests.row("m:a", "new")], hasMore: false))
        #expect(store.transcript("s1").isLive)
        #expect(store.transcript("s1").row(forKey: "m:a")?.content == .assistant(text: "new", streaming: false))
        // A live one is not replaced by the cache.
        store.restoreTranscript("s1", from: Cached(value: TranscriptSnapshot(session: nil, status: nil, rows: [], hasMore: false),
                                                   savedAt: savedAt))
        #expect(store.transcript("s1").rows.count == 1)
        store.markStale(at: savedAt)
        #expect(store.transcript("s1").savedAt == savedAt)
    }
}

import Foundation
@testable import RealmKit
import Testing

/// mobile.v1 as the Mac writes it today (PROTOCOL.md §8, §9): `packages/remote/test/fixtures/ts-api.json`
/// is made by the server's own projector and API, and every answer in it must decode here, carrying
/// what the desktop shows — questions with their keys, kinds, picks and secrets, a plan to approve,
/// the hint, the agent's and model's names, the space's icon, a turn's diff and the files it made.
@Suite("mobile.v1 as the Mac writes it")
struct APIFixtureTests {
    static let available = Fixtures.typeScriptExists("ts-api.json")

    /// One part of the fixture, by its path of keys, as JSON to decode.
    static func part(_ keys: [String]) throws -> Data {
        var value: Any = try JSONSerialization.jsonObject(with: Data(contentsOf: Fixtures.typeScript("ts-api.json")))
        for key in keys {
            guard let object = value as? [String: Any], let next = object[key] else { throw CocoaError(.coderValueNotFound) }
            value = next
        }
        return try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    }

    static func decode<T: Decodable>(_ type: T.Type, _ keys: String...) throws -> T {
        try JSONDecoder().decode(T.self, from: part(keys))
    }

    static func opened() throws -> OpenedSession { try decode(OpenedSession.self, "calls", "session.open") }

    static func request(_ id: String, in opened: OpenedSession) -> TranscriptRow.Request? {
        for row in opened.rows { if case .request(let request) = row.content, request.requestId == id { return request } }
        return nil
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func homeNamesAgentsAndModelsAndReadsEachSpacesIcon() throws {
        let home = try Self.decode(Home.self, "calls", "home.get")
        #expect(home.needsYou.map(\.id) == ["01JSESSION00000000000000000", "01JCODEX000000000000000000"])
        let first = try #require(home.needsYou.first)
        #expect(first.agentName == "Claude")
        #expect(first.agentMark == "claude")
        #expect(first.modelLabel == "Opus 5.5")
        #expect(first.modelDisplayName == "Opus 5.5")
        #expect(home.needsYou[1].modelDisplayName == "GPT-5.6", "a model nobody pinned is named by its default")
        #expect(home.spaces.map(\.iconKind) == [.glyph, .emoji, .picture])
        #expect(home.spaces[0].glyph == "code")
        #expect(home.spaces[1].emoji == "🌊")
        #expect(home.spaces[2].hasPicture)
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aQuestionCarriesItsKeysKindsPicksAndSecrets() throws {
        let opened = try Self.opened()
        let request = try #require(Self.request("q-open", in: opened))
        #expect(request.asker == "Linear's MCP server")
        #expect(request.message == "To file the issue")
        let questions = try #require(request.questions)
        #expect(questions.map(\.answerKey) == ["team", "labels", "token", "ship"])
        #expect(questions.map(\.kind) == ["choice", "multi", "text", "confirm"])
        #expect(questions.map(\.multiSelect) == [false, true, false, false])
        #expect(questions.map(\.allowOther) == [true, true, false, false])
        #expect(questions.map(\.secret) == [false, false, true, false])
        #expect(questions[2].required)
        #expect(questions[0].options.map(\.answerValue) == ["eng", "ops"])
        // A yes-or-no carries the two options the desktop draws, and takes no words.
        #expect(questions[3].options.map(\.label) == ["Yes", "No"])
        #expect(!questions[3].takesText)
        let answerable = questions.allSatisfy { $0.isAnswerableHere }
        #expect(answerable)
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func anAnsweredRequestKeepsItsAnswersAndASecretOnlyAsItsMark() throws {
        let request = try #require(Self.request("q-done", in: try Self.opened()))
        #expect(request.state == .allowed)
        #expect(request.answers == ["team": .one("eng"), "labels": .several(["bug", "Regression"]), "token": .one("••••••"), "ship": .one("yes")])
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aPlanToApproveCarriesItsTextAndSteps() throws {
        let request = try #require(Self.request("x1", in: try Self.opened()))
        #expect(request.kind == .plan)
        #expect(request.plan == PendingPlan(text: "## Theme column\n\nAdd it, then backfill it.",
                                            steps: [PlanStep(text: "Add the column", status: "completed"), PlanStep(text: "Backfill it", status: "in_progress")]))
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theSessionOpensWithItsHintAndItsLinksOut() throws {
        let opened = try Self.opened()
        #expect(opened.hint == "Approve the plan and run the migration")
        let changed = try #require(opened.rows.first { $0.checkpointId != nil })
        #expect(changed.checkpointId == "01JCHECKPOINT0000000000000")
        let made = try #require(opened.rows.first { $0.madeFiles != nil })
        #expect(made.madeFiles?.map(\.name) == ["slide.png", "notes.md", "walkthrough.mp4"])
        let drawn = opened.rows.allSatisfy { if case .unknown = $0.content { false } else { true } }
        #expect(drawn, "every row the Mac makes today is one this phone draws")
        // And the snapshot the cache keeps holds them as they came.
        let again = try JSONDecoder().decode(OpenedSession.self, from: JSONEncoder().encode(opened))
        #expect(again == opened)
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aTurnsChangesAndItsDiffDecode() throws {
        let changes = try Self.decode(TurnChanges.self, "calls", "session.changes")
        #expect(changes.files.map(\.path) == ["src/theme.ts", "src/new-name.ts"])
        #expect(changes.files[1].oldPath == "src/old-name.ts")
        let page = try Self.decode(DiffPage.self, "calls", "session.diff")
        #expect(page.next == nil)
        #expect(page.total == page.lines.count)
        #expect(page.lines.map(DiffPage.kind(of:)) == [.fileHeader, .fileHeader, .hunkHeader, .context, .removed, .added, .added, .note])
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func eachPreviewOfAMadeFileDecodes() throws {
        let image = try Self.decode(FilePreview.self, "calls", "session.file:image")
        #expect(image.preview == .image(mime: "image/jpeg", data: Data("jpeg".utf8)))
        let text = try Self.decode(FilePreview.self, "calls", "session.file:text")
        #expect(text.preview == .text("# Deck notes\n\nThree slides.\n", truncated: false))
        #expect(text.name == "notes.md")
        let none = try Self.decode(FilePreview.self, "calls", "session.file:none")
        #expect(none.preview == .none(reason: "Open this on your Mac to play it."))
        let picture = try Self.decode(SpacePicture.self, "calls", "space.icon")
        #expect(picture.mime == "image/png")
        #expect(picture.data == Data("a picture".utf8))
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theHintEventDecodes() throws {
        let hints = try JSONSerialization.jsonObject(with: Self.part(["events", "session.hint"])) as? [Any] ?? []
        let events = try hints.map { payload in
            Envelope.classify(try JSONSerialization.data(withJSONObject: ["event": "session.hint", "payload": payload]))
        }
        guard case .event(.sessionHint(let first)) = events.first, case .event(.sessionHint(let cleared)) = events.last else {
            Issue.record("session.hint did not decode")
            return
        }
        #expect(first == SessionHintEvent(id: "01JSESSION00000000000000000", text: "Approve the plan and run the migration"))
        #expect(cleared.text == nil)
    }

    /// The phone's card, answering the open question, sends exactly what the Mac's own card keeps.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theCardsAnswerIsTheOneTheMacKeeps() throws {
        let request = try #require(Self.request("q-open", in: try Self.opened()))
        let questions = try #require(request.questions)
        let picks = try Self.decode([String: [String]].self, "answer", "picks")
        let own = try Self.decode([String: String].self, "answer", "own")
        var draft = AnswerDraft(sessionId: "s", requestId: request.requestId, questions: questions)
        for question in questions {
            for label in picks[question.answerKey] ?? [] { draft.toggle(label, in: question) }
            if let words = own[question.answerKey] { draft.setOther(words, for: question) }
        }
        #expect(draft.isComplete)
        #expect(draft.values == (try Self.decode([String: AnswerValue].self, "answer", "values")))
    }
}

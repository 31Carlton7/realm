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
        #expect(home.needsYou[1].modelDisplayName == "GPT-6 Astra", "a model nobody pinned is named by the default its CLI marks")
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
        let whole = try Self.decode(FilePiece.self, "calls", "session.fileData")
        #expect(whole.data == Data("# Deck notes\n\nThree slides.\n".utf8))
        #expect(whole.size == whole.data.count)
        #expect(whole.from == 0)
        #expect(whole.next == nil)
        let picture = try Self.decode(SpacePicture.self, "calls", "space.icon")
        #expect(picture.mime == "image/png")
        #expect(picture.data == Data("a picture".utf8))
    }

    /// A session's screens, live first, each with its words, and a picture of one as the Mac made it.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aSessionsScreensAndAPictureOfOneDecode() throws {
        struct Answer: Decodable { let screens: [SessionScreen] }
        let screens = try Self.decode(Answer.self, "calls", "session.screens").screens
        #expect(screens.map(\.kind) == [.simulator, .machine, .simulator, .machine])
        #expect(screens.first == SessionScreen(id: "01JSIMULATOR00000000000001", kind: .simulator, name: "iPhone 17 Pro",
                                               detail: "iOS Simulator", live: true))
        #expect(screens.map(\.live) == [true, true, false, false])
        let frame = try Self.decode(ScreenFrame.self, "calls", "session.screen")
        #expect(frame.mime == "image/jpeg")
        #expect(frame.data.starts(with: [0xFF, 0xD8]))
        #expect(frame.width == 460 && frame.height == 1000 && frame.capturedAt > 0)
    }

    /// A session's browser and terminal panes, a picture of a page, and a terminal's output drawn as text.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aSessionsPanesAPageAndATerminalDecode() throws {
        let panes = try Self.decode(SessionPanes.self, "calls", "session.panes")
        #expect(panes.browsers.map(\.name) == ["Realm docs", "Admin"])
        #expect(panes.browsers.map(\.live) == [true, false])
        #expect(panes.browsers[0].url == "http://localhost:4000/docs")
        #expect(panes.browsers[0].favicon == Data("an icon".utf8))
        #expect(panes.browsers[1].favicon == nil)
        #expect(panes.terminals == [TerminalPane(id: "01JTERMINAL000000000000001", name: "realm", detail: "~/realm", running: true),
                                    TerminalPane(id: "01JTERMINAL000000000000002", name: "build", detail: "pnpm build", running: false)])
        let frame = try Self.decode(ScreenFrame.self, "calls", "session.browserFrame")
        #expect(frame.data.starts(with: [0xFF, 0xD8]))
        #expect(frame.width == 1000 && frame.height == 625)
        let output = try Self.decode(TerminalOutput.self, "calls", "session.terminal")
        #expect(output.reset && output.running)
        #expect(output.cursor == TerminalCursor(runId: "01JRUN0000000000000000000A", seq: 4))
        var text = TerminalText()
        text.feed(output.text)
        #expect(text.lines.map(\.text) == ["Last login: Tue Nov  4 08:00", "me@mac realm % ls", "apps  packages  README.md", "error warn ok"])
        #expect(text.lines[3].runs.map(\.style.foreground) == [.indexed(1), nil, .indexed(214), nil, .rgb(0, 200, 120)])
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

    /// A fork, a move to another space, a switch of agent or of login each answer with the row as it is
    /// now; the logins name the CLI's own; saved turns are their prompts' seqs.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theSessionActionsDecode() throws {
        struct Moved: Decodable { let session: SessionRow }
        let fork = try Self.decode(Moved.self, "calls", "session.fork").session
        #expect(fork.title == "Fork: Theme column" && fork.spaceId == "sp1")
        #expect(try Self.decode(Moved.self, "calls", "session.moveToSpace").session.spaceName == "Deck")
        let switched = try Self.decode(Moved.self, "calls", "session.switchAgent").session
        #expect(switched.agent == "codex" && switched.agentName == "Codex")
        _ = try Self.decode(Moved.self, "calls", "session.setAccount")
        let logins = try Self.decode(SessionAccounts.self, "calls", "session.accounts")
        #expect(logins.current == "default-claude")
        #expect(logins.accounts.map(\.detail) == ["me@example.com", nil])
        let listing = try Self.decode(DocumentListing.self, "calls", "documents.list")
        #expect(listing.folder == "Deck" && listing.total == 3 && listing.next == nil)
        #expect(listing.entries.map(\.path) == ["drafts", "notes.md", "slide.png"])
        #expect(listing.entries.map(\.kind) == ["folder", "doc", "preview"])
        #expect(listing.entries[0].isDir && listing.entries[2].mime == "image/png")
        let page = try Self.decode(DocumentListing.self, "calls", "documents.list:page")
        #expect(page.entries.map(\.path) == ["notes.md"] && page.next == 2)
        let found = try Self.decode(DocumentSearch.self, "calls", "documents.search")
        #expect(found.entries.map(\.path) == ["notes.md"] && found.withheld == nil)
        let withheld = try Self.decode(DocumentSearch.self, "calls", "documents.search:withheld")
        #expect(withheld.withheld?.path == ".env")
        #expect(try Self.decode(FilePreview.self, "calls", "documents.file").name == "notes.md")
        #expect(try Self.decode(FilePiece.self, "calls", "documents.fileData").modifiedAt == 1_790_000_000_000)
        let shelf = try Self.decode(LibraryPage.self, "calls", "library.files")
        #expect(shelf.entries.map(\.origin) == ["output", "added"])
        #expect(shelf.entries[0].sessionTitle == "Theme column" && shelf.entries[0].kind == "doc" && shelf.next == nil)
        #expect(shelf.entries[1].sessionId == nil && shelf.entries[1].sessionTitle == nil && shelf.entries[1].name == "brief.pdf")
        #expect(try Self.decode(FilePreview.self, "calls", "library.file").name == "notes.md")
        #expect(try Self.decode(FilePiece.self, "calls", "library.fileData").next == nil)
        let memory = try Self.decode(MemoryOverview.self, "calls", "memory.overview")
        #expect(memory.places.map(\.id) == ["every:p1", "space:sp1", "agent:claude"])
        #expect(memory.places.map(\.kind) == [.every, .space, .agent] && memory.places[1].spaceId == "sp1")
        #expect(memory.places[2].entries.first?.source == "Claude · User memory" && memory.places[2].entries.first?.description == nil)
        #expect(memory.homes.map(\.label) == ["Memory repo · every space", "Memory repo · Realm", "Memory repo · Deck"] && memory.learning)
        let memories = try Self.decode(MemoryPage.self, "calls", "memory.list")
        #expect(memories.entries.map(\.title) == ["Ships Fridays"] && memories.next == nil)
        #expect(try Self.decode(MemoryPage.self, "calls", "memory.list:search").next == 1)
        let remembered = try Self.decode(MemoryFile.self, "calls", "memory.file")
        #expect(remembered.title == "Ships Fridays" && remembered.writable && !remembered.external && remembered.note == nil)
        #expect(remembered.text.hasPrefix("---") && remembered.body.hasPrefix("Releases go out"))
        #expect(remembered.frontmatter.last == .init(key: "metadata.type", value: "project"))
        #expect(remembered.links.first?.id == "realm-repo-profile-p1:spaces/realm/uses-pnpm.md")
        #expect(remembered.readBy.first == .init(who: "Every agent", where: "in Realm", how: "through Realm's memory tools"))
        #expect(try Self.decode(MemoryFile.self, "calls", "memory.write").id == remembered.id)
        #expect(try Self.decode(MemoryFile.self, "calls", "memory.create").id == remembered.id)
        let saved = try Self.decode(SavedTurns.self, "calls", "saved.list")
        #expect(saved.total == 1 && saved.entries.first?.seq == 2 && saved.entries.first?.spaceName == "Realm")
        let events = try JSONSerialization.jsonObject(with: Self.part(["events", "session.saved"])) as? [Any] ?? []
        let event = Envelope.classify(try JSONSerialization.data(withJSONObject: ["event": "session.saved", "payload": events[0]]))
        guard case .event(.sessionSaved(let update)) = event else {
            Issue.record("session.saved did not decode")
            return
        }
        #expect(update == SessionSavedEvent(id: "01JSESSION00000000000000000", seqs: [2, 5]))
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

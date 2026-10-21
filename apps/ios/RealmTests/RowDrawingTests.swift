import RealmKit
import SwiftUI
import Testing
import UIKit
import Vision
@testable import Realm

/// Draws a view the way the screen does — hosted in a window, so UIKit-backed pieces draw too — and
/// reads back the words on it with Vision.
@MainActor
enum Drawing {
    /// How many drawings went to `DRAWING_DUMP`, a folder to write each one to while a test is looked into.
    static var dumped = 0

    static func image(of view: some View, width: CGFloat = 390, dark: Bool = true,
                      size: DynamicTypeSize = .large) throws -> UIImage {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = dark ? .dark : .light
        let host = UIHostingController(rootView: view.frame(width: width).fixedSize(horizontal: false, vertical: true)
            .padding(16).background(Ground.transcript).dynamicTypeSize(size))
        host.sizingOptions = [.preferredContentSize]
        window.rootViewController = host
        window.makeKeyAndVisible()
        let fitted = host.sizeThatFits(in: CGSize(width: width + 32, height: 4_000))
        window.frame = CGRect(origin: .zero, size: CGSize(width: width + 32, height: max(1, fitted.height)))
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
        let image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        window.isHidden = true
        return image
    }

    static func words(_ view: some View, width: CGFloat = 390, dark: Bool = true, size: DynamicTypeSize = .large) throws -> String {
        let image = try image(of: view, width: width, dark: dark, size: size)
        if let folder = ProcessInfo.processInfo.environment["DRAWING_DUMP"] {
            dumped += 1
            try? image.pngData()?.write(to: URL(fileURLWithPath: folder).appending(path: "drawing-\(dumped).png"))
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: try #require(image.cgImage)).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }
}

/// A model with one open session, as the Mac would have sent it.
@MainActor
func modelWithSession(agent: String = "claude", status: SessionStatus = .waiting, rows: [TranscriptRow] = []) -> AppModel {
    let model = AppModel()
    model.store.finishOpening(OpenedSession(
        session: SessionRow(id: "s1", title: "T", spaceId: "sp", spaceName: "Realm", agent: agent, model: nil, status: status,
                            needsYou: status == .waiting, unread: false, updatedAt: 0),
        rows: rows, hasMore: false))
    return model
}

@MainActor
@Suite("Every row of a transcript draws", .serialized)
struct RowDrawingTests {
    static func row(_ content: TranscriptRow.Content, key: String = "k:1") -> TranscriptRow {
        TranscriptRow(key: key, seq: 4, content: content)
    }

    static func words(_ content: TranscriptRow.Content, model: AppModel = AppModel(), dark: Bool = true) throws -> String {
        try Drawing.words(TranscriptRowView(row: row(content), sessionId: "s1").environment(model), dark: dark)
    }

    static let permission = TranscriptRow.Request(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test",
                                                  state: .pending, questions: nil)

    /// A row this version cannot draw says so: nothing in a transcript is ever blank.
    @Test func anUnknownRowSaysOpenThisOnYourMac() throws {
        #expect(try Self.words(.unknown(kind: "diff", type: nil)).contains("Open this on your Mac"))
        #expect(try Self.words(.unknown(kind: "unknown", type: "rate_limit")).contains("Open this on your Mac"))
    }

    @Test func everyKnownKindDrawsItsWords() throws {
        #expect(try Self.words(.user(text: "Run the tests")).contains("Run the tests"))
        #expect(try Self.words(.assistant(text: "All **four** pass.", streaming: false)).contains("four pass"))
        #expect(try Self.words(.assistant(text: "Reading the page", streaming: true)).contains("Writing"))
        #expect(try Self.words(.thinking(text: "Hmm")).contains("Thinking"))
        let tool = try Self.words(.tool(name: "Bash", summary: "pnpm test", state: .done, detail: "ok"))
        #expect(tool.contains("Ran") && tool.contains("pnpm test"), "\(tool)")
        let plan = try Self.words(.plan(text: nil, steps: [PlanStep(text: "Carry the plan", status: "in_progress")]))
        #expect(plan.contains("Plan") && plan.contains("Carry the plan"))
        #expect(try Self.words(.notice(text: "Context compacted")).contains("Context compacted"))
        let error = try Self.words(.error(text: "Out of credits", hint: "Top up in Settings"))
        #expect(error.contains("Out of credits") && error.contains("Top up"))
    }

    /// The light face draws the same words: no ink there has gone to the paper's colour.
    @Test func theLightFaceDrawsTheSameWords() throws {
        let error = try Self.words(.error(text: "Out of credits", hint: "Top up in Settings"), dark: false)
        #expect(error.contains("Out of credits") && error.contains("Top up"))
        let permission = try Self.words(.request(Self.permission), dark: false)
        #expect(permission.contains("Allow Bash?") && permission.contains("pnpm test"))
    }

    @Test func aPlanSaysHowFarAlongItIs() throws {
        let words = try Self.words(.plan(text: nil, steps: [PlanStep(text: "Carry the plan", status: "completed"),
                                                            PlanStep(text: "Draw it", status: "in_progress"),
                                                            PlanStep(text: "Test it", status: "pending")]))
        #expect(words.contains("1 of 3 done"))
    }

    /// The card in the transcript says what is asked and where it stands; the answers are docked.
    @Test func aPermissionSaysWhatItAsksAndWhereItStands() throws {
        let words = try Self.words(.request(Self.permission), model: modelWithSession())
        #expect(words.contains("Claude asks"))
        #expect(words.contains("Allow Bash?"))
        #expect(words.contains("Waiting on you"))
        #expect(!words.contains("Deny"))
    }

    /// Answered, the card stays as the question and its answer.
    @Test func anAnsweredPermissionKeepsItsWords() throws {
        let allowed = TranscriptRow.Request(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test", state: .allowed,
                                            questions: nil)
        let words = try Self.words(.request(allowed))
        #expect(words.contains("Allow Bash?") && words.contains("Allowed"))
    }

    /// An answered question shows what was answered, a secret one only as its mark.
    @Test func anAnsweredQuestionShowsItsAnswers() throws {
        let questions = [Question(question: "Which database?", header: "Database", multiSelect: false,
                                  options: [QuestionOption(label: "SQLite", description: nil)], id: "db"),
                         Question(question: "Token?", header: "Token", multiSelect: false, options: [], secret: true, id: "token")]
        let request = TranscriptRow.Request(requestId: "q1", tool: "AskUserQuestion", title: "", summary: "", state: .allowed,
                                            questions: questions, answers: ["db": .one("SQLite"), "token": .one("••••••")])
        let words = try Self.words(.request(request))
        #expect(words.contains("Database: SQLite"), "\(words)")
        #expect(words.contains("Answered"))
    }

    /// A card says who is asking first: the asker the Mac names, else the session's agent.
    @Test func aQuestionSaysWhoAsks() throws {
        let questions = [Question(question: "Which database should this use?", header: "Database", multiSelect: false,
                                  options: [QuestionOption(label: "SQLite", description: nil)])]
        let request = TranscriptRow.Request(requestId: "q1", tool: "AskUserQuestion", title: "", summary: "", state: .pending,
                                            questions: questions, asker: "Linear's MCP server", message: "Before I file the issue.")
        let words = try Self.words(.request(request), model: modelWithSession(agent: "codex"))
        #expect(words.contains("Linear's MCP server asks") || words.contains("Linear’s MCP server asks"), "\(words)")
        #expect(words.contains("Before I file the issue."))
        #expect(words.contains("Which database should this use?"))
    }

    /// The dock holds the answers: Allow and Deny for a permission, in place.
    @Test func theDockAnswersAPermissionInPlace() throws {
        let model = modelWithSession(rows: [Self.row(.request(Self.permission), key: "r:r1")])
        let pending = try #require(PendingRequest.first(in: model.store.transcript("s1"), outbox: model.store.outbox))
        let words = try Drawing.words(WaitingDock(pending: pending, sessionId: "s1", fold: {}).environment(model))
        #expect(words.contains("Claude asks") && words.contains("Allow Bash?"))
        #expect(words.contains("Deny") && words.contains("Allow"))
    }

    /// A plan is approved, not allowed: the dock opens it to be read, the sheet implements it.
    @Test func aPlanIsReviewedThenImplemented() throws {
        let request = TranscriptRow.Request(requestId: "p1", tool: "ExitPlanMode", title: "Exit plan mode?", summary: "Ship the mapper",
                                            state: .pending, questions: nil,
                                            plan: PendingPlan(text: "Ship the mapper", steps: [PlanStep(text: "Carry the plan", status: "pending")]))
        let model = modelWithSession(rows: [Self.row(.request(request), key: "r:p1")])
        let pending = try #require(PendingRequest.first(in: model.store.transcript("s1"), outbox: model.store.outbox))
        let dock = try Drawing.words(WaitingDock(pending: pending, sessionId: "s1", fold: {}).environment(model))
        #expect(dock.contains("A plan to approve") && dock.contains("1 step"), "\(dock)")
        #expect(dock.contains("Review the plan") && dock.contains("Keep planning"), "\(dock)")
        let card = try Self.words(.request(request), model: model)
        #expect(card.contains("Carry the plan") && card.contains("Ship the mapper"))
    }

    /// An answer given while the Mac sleeps is kept, and the dock says where it is.
    @Test func anAnswerWaitingForASleepingMacSaysSo() throws {
        let model = modelWithSession(rows: [Self.row(.request(Self.permission), key: "r:r1")])
        model.store.connection = .macOffline(lastSeen: 1_790_000_000_000)
        model.store.enqueueAnswer(.allow, to: "r1", in: "s1")
        let pending = try #require(PendingRequest.first(in: model.store.transcript("s1"), outbox: model.store.outbox))
        let words = try Drawing.words(WaitingDock(pending: pending, sessionId: "s1", fold: {}).environment(model))
        #expect(words.contains("You allowed it"))
        #expect(words.contains("Your Mac is asleep"))
        #expect(words.contains("Don't send") || words.contains("Don’t send"))
    }

    /// A message shows what went with it under its words: a file as a chip by its name.
    @Test func aMessageShowsTheFilesThatWentWithIt() throws {
        let notes = SentFile(path: "/Users/me/Realm/tmp/attachments/x1-notes.pdf", name: "notes.pdf", mime: "application/pdf")
        let row = TranscriptRow(key: "u:3", seq: 3, content: .user(text: "Read this"), sentFiles: [notes])
        let words = try Drawing.words(TranscriptRowView(row: row, sessionId: "s1").environment(AppModel()))
        #expect(words.contains("Read this") && words.contains("notes.pdf"), "\(words)")
    }

    /// The work is quiet lines that say what they did, in the tense of their state.
    @Test func workSaysWhatItDid() throws {
        let rows = [Self.row(.tool(name: "Read", summary: "AppSettings.tsx", state: .done, detail: nil), key: "t1"),
                    Self.row(.tool(name: "Edit", summary: "AppSettings.tsx", state: .done, detail: nil), key: "t2"),
                    Self.row(.tool(name: "Bash", summary: "pnpm vitest", state: .running, detail: nil), key: "t3")]
        let words = try Drawing.words(WorkRun(rows: rows, sessionId: "s1").environment(AppModel()))
        #expect(words.contains("Read") && words.contains("Edited") && words.contains("Running"), "\(words)")
    }
}

@MainActor
@Suite("A session on Home", .serialized)
struct SessionRowTests {
    static let row = SessionRow(id: "s1", title: "Add the dark-mode toggle", spaceId: "sp1", spaceName: "Realm", agent: "claude",
                                model: "claude-opus-5-5", status: .waiting, needsYou: true, unread: true,
                                updatedAt: 1_790_000_000_000, agentName: "Claude", agentMark: "claude", modelLabel: "Opus 5.5")

    @Test func aRowDrawsItsTitleStateAndModel() throws {
        let words = try Drawing.words(SessionRowView(row: Self.row, space: nil).environment(AppModel()))
        #expect(words.contains("Add the dark-mode toggle"), "\(words)")
        #expect(words.contains("Waiting on you"), "\(words)")
        #expect(words.contains("Opus 5.5"), "\(words)")
    }

    /// At the largest accessibility size nothing shares a line with the state, and it all still draws.
    @Test func aRowStillReadsAtTheLargestSize() throws {
        let words = try Drawing.words(SessionRowView(row: Self.row, space: nil).environment(AppModel()), size: .accessibility5)
        #expect(words.contains("Waiting"), "\(words)")
        #expect(words.contains("toggle"), "\(words)")
    }

    @Test func aRowSaysEverythingItShowsInWords() {
        let now = Date(timeIntervalSince1970: 1_790_000_120)
        #expect(SessionRowView.spoken(Self.row, now: now)
                == "Add the dark-mode toggle, Waiting on you, Unread, Realm, Claude, Opus 5.5, 2m ago")
        let quiet = SessionRow(id: "s2", title: "", spaceId: "sp1", spaceName: "Realm", agent: "codex", model: nil, status: .idle,
                               needsYou: false, unread: false, updatedAt: 1_790_000_000_000)
        #expect(SessionRowView.spoken(quiet, now: now) == "Untitled session, Realm, Codex, 2m ago")
    }

    /// A row says the state a person would act on or want to know, and nothing for one at rest.
    @Test func aRowSaysOnlyTheStateWorthSaying() {
        let make = { (status: SessionStatus, unread: Bool) in
            SessionRow(id: "s", title: "T", spaceId: "sp", spaceName: "", agent: "claude", model: nil, status: status, needsYou: false,
                       unread: unread, updatedAt: 0)
        }
        #expect(RowState(make(.waiting, false)) == .waiting)
        #expect(RowState(make(.running, false)) == .working)
        #expect(RowState(make(.error, false)) == .failed)
        #expect(RowState(make(.idle, true)) == .done)
        #expect(RowState(make(.idle, false)) == nil)
        #expect(RowState(make(.ended, true)) == nil)
        #expect(RowState.done.word == "Done" && RowState.working.word == "Working")
    }

    @Test func stopIsOfferedOnlyWhileATurnIsUnderWay() {
        let make = { (status: SessionStatus) in
            SessionRow(id: "s", title: "T", spaceId: "sp", spaceName: "", agent: "claude", model: nil, status: status, needsYou: false,
                       unread: false, updatedAt: 0)
        }
        #expect(make(.running).isWorking && make(.waiting).isWorking)
        #expect(!make(.idle).isWorking && !make(.error).isWorking && !make(.ended).isWorking)
    }
}

@MainActor
@Suite("What has not gone to the Mac")
struct UnsentTests {
    static func row(_ id: String, _ title: String, space: String, spaceName: String, agent: String = "claude",
                    status: SessionStatus = .idle) -> SessionRow {
        SessionRow(id: id, title: title, spaceId: space, spaceName: spaceName, agent: agent, model: nil, status: status,
                   needsYou: status == .waiting, unread: false, updatedAt: 0)
    }

    static let home: Home = {
        let toggle = row("a", "Add the dark-mode toggle", space: "realm", spaceName: "Realm", status: .waiting)
        let relay = row("b", "Explain the relay", space: "realm", spaceName: "Realm")
        let database = row("c", "Choose the database", space: "site", spaceName: "Site", agent: "codex", status: .waiting)
        return Home(mac: MacInfo(name: "MacBook Pro"), needsYou: [database, toggle], spaces: [
            Space(id: "realm", name: "Realm", icon: "emoji:🌊", color: "#3b82f6", sessions: [toggle, relay], more: 2),
            Space(id: "site", name: "Site", icon: "rocket", color: "#10b981", sessions: [database], more: 0),
        ])
    }()

    /// What has not gone to the Mac is gathered by session: a refusal always, held work while away.
    @Test func whatHasNotGoneIsGatheredBySession() {
        var outbox = Outbox()
        let message = OutgoingItem(sessionId: "b", payload: .message(text: "Ship it"), afterSeq: 0)
        let answer = OutgoingItem(sessionId: "b", payload: .answer(requestId: "r1", decision: .allow, answers: nil), afterSeq: 0)
        let refused = OutgoingItem(sessionId: "a", payload: .message(text: "Go"), state: .failed("The session ended."), afterSeq: 0)
        for item in [message, answer, refused] { outbox.add(item) }

        let away = UnsentSession.list(outbox: outbox, home: Self.home, connected: false)
        #expect(away.map(\.id) == ["b", "a"])
        #expect(away.first?.title == "Explain the relay")
        #expect(away.first?.what == "A message and an answer")

        // Connected, what is held is on its way; only the refusal stays.
        let live = UnsentSession.list(outbox: outbox, home: Self.home, connected: true)
        #expect(live.map(\.id) == ["a"])
        #expect(UnsentSession.list(outbox: outbox, home: nil, connected: true).first?.title == "A session")
    }
}

@MainActor
@Suite("How a transcript is laid out")
struct TranscriptLayoutTests {
    static func row(_ key: String, _ content: TranscriptRow.Content, checkpoint: String? = nil) -> TranscriptRow {
        TranscriptRow(key: key, seq: 1, content: content, checkpointId: checkpoint)
    }

    static func user(_ key: String) -> TranscriptRow { row(key, .user(text: "Build it")) }
    static func tool(_ key: String, _ name: String) -> TranscriptRow { row(key, .tool(name: name, summary: "a", state: .done, detail: nil)) }
    static func said(_ key: String) -> TranscriptRow { row(key, .assistant(text: "Done", streaming: false)) }

    static let rows = [user("u1"), tool("t1", "Read"), row("k1", .thinking(text: "Hmm")), tool("t2", "Edit"), said("a1"), tool("t3", "Bash")]

    /// In a turn still going, the work is quiet lines and what is said stands on its own.
    @Test func aTurnStillGoingShowsItsWork() {
        let items = TranscriptLayout.items(Self.rows, settled: false)
        #expect(items.map(\.id) == ["u1", "work/t1", "a1", "work/t3"])
        guard case .work(let work, _) = items[1] else { Issue.record("the run is not work"); return }
        #expect(work.map(\.key) == ["t1", "k1", "t2"])
    }

    /// Finished, everything on the way to the answer folds, and the answer stands.
    @Test func aFinishedTurnFoldsOnTheWayToItsAnswer() {
        #expect(TranscriptLayout.items(Self.rows, settled: true).map(\.id) == ["u1", "fold/t1", "a1", "fold/t3"])
        let earlier = [Self.user("u1"), Self.said("p1"), Self.tool("t1", "Read"), Self.said("a1"), Self.user("u2"), Self.tool("t2", "Bash")]
        #expect(TranscriptLayout.items(earlier, settled: false).map(\.id) == ["u1", "fold/p1", "a1", "u2", "work/t2"])
    }

    /// What a person may need to act on or see is never folded away, and words alone are not folded.
    @Test func aFoldNeverHidesWhatMatters() {
        let request = Self.row("r1", .request(.init(requestId: "r1", tool: "Bash", title: "", summary: "", state: .allowed, questions: nil)))
        let changes = Self.row("c1", .notice(text: "Changed 1 file"), checkpoint: "cp1")
        let rows = [Self.user("u1"), Self.tool("t1", "Read"), request, Self.tool("t2", "Edit"), changes, Self.said("a1")]
        #expect(TranscriptLayout.items(rows, settled: true).map(\.id) == ["u1", "fold/t1", "r1", "fold/t2", "c1", "a1"])
        let talk = [Self.user("u1"), Self.said("p1"), Self.said("a1")]
        #expect(TranscriptLayout.items(talk, settled: true).map(\.id) == ["u1", "p1", "a1"])
    }

    @Test func everyRowIsDrawnOnceAndInOrder() {
        for settled in [false, true] {
            let keys = TranscriptLayout.items(Self.rows, settled: settled).flatMap { item -> [String] in
                switch item {
                case .row(let row): [row.key]
                case .work(let rows, _), .folded(let rows, _): rows.map(\.key)
                }
            }
            #expect(keys == Self.rows.map(\.key))
        }
    }

    /// A run keeps its identity as it grows, so it does not redraw from nothing with each call.
    @Test func aRunKeepsItsPlaceAsItGrows() {
        #expect(TranscriptLayout.items(Array(Self.rows.prefix(2)), settled: false).map(\.id) == ["u1", "work/t1"])
        #expect(TranscriptLayout.items(Array(Self.rows.prefix(4)), settled: false).map(\.id) == ["u1", "work/t1"])
    }

    /// An edit's line opens onto its own turn's changes, never a later turn's.
    @Test func workKnowsItsTurnsChanges() {
        let rows = [Self.user("u1"), Self.tool("t1", "Edit"), Self.row("c1", .notice(text: "Changed"), checkpoint: "cp1"), Self.said("a1"),
                    Self.user("u2"), Self.tool("t2", "Edit")]
        let items = TranscriptLayout.items(rows, settled: false)
        guard case .folded(_, let first) = items[1], case .work(_, let second) = items.last else { Issue.record("\(items.map(\.id))"); return }
        #expect(first == "cp1")
        #expect(second == nil)
    }

    /// The request the foot holds is told from every other row by its id.
    @Test func theHeldRequestIsKnownByItsId() {
        let request = Self.row("r", .request(TranscriptRow.Request(requestId: "r1", tool: "Bash", title: "", summary: "ls",
                                                                    state: .pending, questions: nil)))
        #expect(request.isRequest("r1"))
        #expect(!request.isRequest("r2"))
        #expect(!request.isRequest(nil))
        #expect(!Self.user("u1").isRequest("r1"))
    }

    @Test func reviewChangesIsTheNewestTurnsUntilSomethingIsSaid() {
        let settled = [Self.user("u1"), Self.tool("t1", "Edit"), Self.row("c1", .notice(text: "Changed"), checkpoint: "cp1"), Self.said("a1")]
        #expect(TranscriptLayout.reviewable(settled) == "cp1")
        #expect(TranscriptLayout.reviewable(settled + [Self.user("u2")]) == nil)
        #expect(TranscriptLayout.reviewable([Self.user("u1"), Self.said("a1")]) == nil)
        // A turn the Mac measured and found nothing in has nothing to review.
        let nothing = Self.row("c2", .notice(text: "Changed 0 files: "), checkpoint: "cp2")
        #expect(nothing.changedNothing)
        #expect(!Self.row("c3", .notice(text: "Changed 0 files: "), checkpoint: nil).changedNothing)
        #expect(!Self.row("c4", .notice(text: "Changed 10 files: a.ts"), checkpoint: "cp4").changedNothing)
        #expect(TranscriptLayout.reviewable([Self.user("u1"), nothing, Self.said("a1")]) == nil)
    }

    /// What a running turn is doing, where no row on screen already says it.
    @Test func theLiveLineSaysWhatNothingElseDoes() {
        #expect(LiveActivity.of([Self.row("t1", .tool(name: "Bash", summary: "", state: .running, detail: nil))]) == nil)
        #expect(LiveActivity.of([Self.row("a1", .assistant(text: "Wri", streaming: true))]) == nil)
        #expect(LiveActivity.of([Self.row("k1", .thinking(text: "Hmm"))]) == .thinking)
        #expect(LiveActivity.of([Self.user("u1")]) == .working)
        #expect(LiveActivity.of([]) == .working)
    }

    @Test func aFoldSaysHowMuchWorkItHolds() {
        let rows = [Self.said("p1"), Self.tool("t1", "Read"), Self.row("k1", .thinking(text: "Hmm")), Self.tool("t2", "Edit")]
        #expect(FoldedWork.summary(rows) == "Worked · 3 steps")
        #expect(FoldedWork.summary([Self.tool("t1", "Read")]) == "Worked · 1 step")
    }
}

@MainActor
@Suite("What the work and the changes say")
struct WorkWordsTests {
    @Test func aToolSaysWhatItDidInTheTenseOfItsState() {
        #expect(ToolWords.line(tool: "Bash", summary: "pnpm test", running: true) == .init(verb: "Running", object: "pnpm test"))
        #expect(ToolWords.line(tool: "Bash", summary: "pnpm test", running: false) == .init(verb: "Ran", object: "pnpm test"))
        #expect(ToolWords.line(tool: "Edit", summary: "a.ts", running: false).verb == "Edited")
        #expect(ToolWords.line(tool: "Write", summary: "a.ts", running: false).verb == "Wrote")
        #expect(ToolWords.line(tool: "TodoWrite", summary: "3 todos", running: false) == .init(verb: "Updated the plan", object: nil))
        #expect(ToolWords.line(tool: "Linear__create_issue", summary: "", running: false) == .init(verb: "Called Linear__create_issue", object: nil))
        #expect(ToolWords.line(tool: "Read", summary: "Read", running: false).object == nil)
    }

    @Test func anEditFindsItsFileHoweverEitherPathWasShortened() {
        let changes = TurnChanges(checkpointId: "cp", files: [
            ChangedFile(path: "apps/server/src/db/migrations.ts", oldPath: nil, status: "modified", additions: 1, deletions: 3),
            ChangedFile(path: "README.md", oldPath: nil, status: "added", additions: 1, deletions: 0),
        ], totalFiles: 2)
        #expect(Edits.file(named: "/Users/me/realm/apps/server/src/db/migrations.ts", in: changes)?.path == "apps/server/src/db/migrations.ts")
        #expect(Edits.file(named: "db/migrations.ts", in: changes)?.path == "apps/server/src/db/migrations.ts")
        #expect(Edits.file(named: "", in: changes) == nil)
        #expect(Edits.file(named: "other.ts", in: changes) == nil)
        #expect(Edits.changes("Edit") && Edits.changes("Write") && !Edits.changes("Read"))
        #expect(changes.additions == 2 && changes.deletions == 3)
        #expect(ChangesWords.files(changes) == "Changed 2 files")
        #expect(ChangesWords.name("apps/server/src/db/migrations.ts") == "migrations.ts")
        #expect(ChangesWords.folder("apps/server/src/db/migrations.ts") == "apps/server/src/db")
        #expect(ChangesWords.folder("README.md") == nil)
    }

    /// A diff's lines carry the numbers they have in each file, across pages.
    @Test func aDiffIsNumberedByItsHunks() throws {
        var numbering = DiffNumbering()
        let first = numbering.number(["--- a/x", "+++ b/x", "@@ -10,3 +10,4 @@ func", " keep", "-old", "+new", "+more"], from: 0)
        #expect(first.map(\.kind) == [.fileHeader, .fileHeader, .hunkHeader, .context, .removed, .added, .added])
        #expect(first[3].old == 10 && first[3].new == 10)
        #expect(first[4].old == 11 && first[4].new == nil)
        #expect(first[5].new == 11 && first[6].new == 12)
        // The next page carries on from where this one stopped.
        let second = numbering.number([" tail"], from: 7)
        #expect(second[0].id == 7 && second[0].old == 12 && second[0].new == 13)
        let starts = try #require(DiffNumbering.starts("@@ -1 +1,2 @@"))
        #expect(starts.0 == 1 && starts.1 == 1)
        #expect(DiffNumbering.starts("@@ nonsense") == nil)
    }

    /// A diff page is as wide as its longest line, so every line's wash runs as far.
    @Test func aDiffIsAsWideAsItsLongestLine() {
        var numbering = DiffNumbering()
        let lines = numbering.number(["@@ -1,2 +1,2 @@", " short", "+a line twice as long"], from: 0)
        let longest = CGFloat("+a line twice as long".count)
        #expect(DiffLines.width(of: lines, advance: 7.2, gutter: 38) == 38 + 10 + longest * 7.2 + 16)
        #expect(DiffLines.width(of: [], advance: 7.2, gutter: 38) == 64)
    }

    /// Only what the Mac can make a small copy of is asked for one.
    @Test func aPictureIsKnownByItsExtension() {
        #expect(FileKind.isPicture("renders/page.png"))
        #expect(FileKind.isPicture("Shot.JPEG"))
        #expect(!FileKind.isPicture("logo.svg"))
        #expect(!FileKind.isPicture("demo.mp4"))
        #expect(!FileKind.isPicture("README"))
    }

    @Test func aPlanSaysHowFarAlong() {
        #expect(PlanSteps.progress([PlanStep(text: "a", status: "completed"), PlanStep(text: "b", status: "pending")]) == "1 of 2 done")
    }

    /// A turn that changed only pictures has no lines to count, and says none rather than "+0 −0".
    @Test func onlyLinesAreCounted() {
        let pictures = TurnChanges(checkpointId: "cp", files: [
            ChangedFile(path: "renders/page.png", oldPath: nil, status: "added", additions: nil, deletions: nil),
        ], totalFiles: 1)
        #expect(!pictures.countsLines)
        #expect(pictures.spoken == "Changed 1 file")
        let mixed = TurnChanges(checkpointId: "cp", files: [
            ChangedFile(path: "renders/page.png", oldPath: nil, status: "added", additions: nil, deletions: nil),
            ChangedFile(path: "web/lib/orgs.ts", oldPath: nil, status: "modified", additions: 17, deletions: 2),
        ], totalFiles: 2)
        #expect(mixed.countsLines)
        #expect(mixed.spoken == "Changed 2 files, 17 lines added, 2 taken away")
        // A file renamed and nothing else still has lines, none of them changed.
        let renamed = TurnChanges(checkpointId: "cp", files: [
            ChangedFile(path: "b.ts", oldPath: "a.ts", status: "renamed", additions: 0, deletions: 0),
        ], totalFiles: 1)
        #expect(renamed.countsLines)
    }
}

@Suite("Following the newest row")
struct ScrollFootTests {
    /// What is seen ends where the composer begins, not at the window's own bottom.
    @Test func theFootIsWhatIsSeenAboveTheBars() {
        #expect(ScrollFoot(content: 1_000, offset: 300, seen: 1_000, frame: 600).atFoot)
        #expect(ScrollFoot(content: 1_000, offset: 300, seen: 1_000 - ScrollFoot.slack, frame: 600).atFoot)
        #expect(!ScrollFoot(content: 1_000, offset: 300, seen: 1_000 - ScrollFoot.slack - 1, frame: 600).atFoot)
    }

    /// The last rows under the composer are not the foot in view, however near the window's bottom.
    @Test func whatIsUnderTheComposerIsNotSeen() {
        func geometry(offset: CGFloat) -> ScrollGeometry {
            ScrollGeometry(contentOffset: CGPoint(x: 0, y: offset), contentSize: CGSize(width: 402, height: 1_000),
                           contentInsets: EdgeInsets(top: 0, leading: 0, bottom: 150, trailing: 0),
                           containerSize: CGSize(width: 402, height: 874))
        }
        #expect(ScrollFoot(geometry(offset: 276)).atFoot)
        // The window reaches past the content's end, but its last 150 points are the composer's.
        #expect(!ScrollFoot(geometry(offset: 100)).atFoot)
    }

    /// A scroll moves the offset and leaves the frame; a bar that grows changes the frame.
    @Test func theBarsAreToldFromAScroll() {
        func geometry(offset: CGFloat, bar: CGFloat) -> ScrollGeometry {
            ScrollGeometry(contentOffset: CGPoint(x: 0, y: offset), contentSize: CGSize(width: 402, height: 1_000),
                           contentInsets: EdgeInsets(top: 100, leading: 0, bottom: bar, trailing: 0),
                           containerSize: CGSize(width: 402, height: 874))
        }
        let before = ScrollFoot(geometry(offset: 276, bar: 150))
        #expect(ScrollFoot(geometry(offset: 100, bar: 150)).frame == before.frame)
        #expect(ScrollFoot(geometry(offset: 276, bar: 190)).frame < before.frame)
    }
}

@Suite("The pill over a session's foot")
struct PillWordsTests {
    @Test func aTurnsTimeIsSaidInUnits() {
        #expect(PillWords.elapsed(0) == "0s")
        #expect(PillWords.elapsed(12.7) == "12s")
        #expect(PillWords.elapsed(192) == "3m 12s")
        #expect(PillWords.elapsed(3_840) == "1h 4m")
        #expect(PillWords.elapsed(-5) == "0s")
        #expect(PillWords.elapsed(192, spoken: true) == "3 minutes, 12 seconds")
    }

    @Test func aLinkComingBackSaysSo() {
        #expect(PillWords.away(.connecting) == "Connecting…")
        #expect(PillWords.away(.connecting, reconnecting: true) == "Reconnecting…")
        #expect(PillWords.away(.asleep(since: nil), reconnecting: true) == "Mac asleep · Retry")
    }
}

@MainActor
@Suite("What a request asks, and the answer it holds")
struct RequestTests {
    static let questions = [
        Question(question: "Which database?", header: "Database", multiSelect: false,
                 options: [QuestionOption(label: "SQLite", description: nil, value: "sqlite"), QuestionOption(label: "Postgres", description: nil)],
                 id: "db", defaultAnswer: .one("sqlite")),
        Question(question: "Which regions?", header: "", multiSelect: true,
                 options: [QuestionOption(label: "eu-west-1", description: nil), QuestionOption(label: "us-east-1", description: nil)],
                 id: "regions", defaultAnswer: .several(["eu-west-1", "us-east-1"])),
        Question(question: "Name it", header: "", multiSelect: false, options: [], id: "name", defaultAnswer: .one("theme")),
        Question(question: "Token?", header: "", multiSelect: false, options: [], secret: true, id: "token"),
    ]

    @Test func answersReadInTheQuestionsOrderAndASecretIsOnlyItsMark() {
        let questions = [
            Question(question: "Which database?", header: "", multiSelect: false, options: [QuestionOption(label: "SQLite", description: nil)]),
            Question(question: "Token?", header: "", multiSelect: false, options: [], secret: true),
            Question(question: "Which regions?", header: "", multiSelect: true, options: [QuestionOption(label: "eu-west-1", description: nil)]),
        ]
        let words = RequestCard.describe(.allow, answers: ["Which regions?": "eu-west-1", "Token?": "hunter2", "Which database?": "SQLite"],
                                         kind: .questions(questions))
        #expect(words == "You answered: SQLite · •••••• · eu-west-1")
        #expect(!words.contains("hunter2"))
        #expect(RequestCard.describe(.deny, answers: nil, kind: .questions(questions)) == "You skipped these questions.")
        #expect(RequestCard.describe(.allow, answers: nil, kind: .plan) == "You approved the plan.")
    }

    /// The answers the Mac logged, by each question's head, a secret one only as its mark whatever came.
    @Test func anAnsweredRequestSaysItsAnswers() {
        let request = TranscriptRow.Request(requestId: "q", tool: "AskUserQuestion", title: "", summary: "", state: .allowed,
                                            questions: Self.questions,
                                            answers: ["db": .one("SQLite"), "regions": .several(["eu-west-1", "us-east-1"]), "token": .one("hunter2")])
        #expect(RequestCard.answered(request) == "Database: SQLite\nWhich regions?: eu-west-1, us-east-1\nToken?: ••••••")
        let unanswered = TranscriptRow.Request(requestId: "q", tool: "", title: "", summary: "", state: .pending, questions: Self.questions)
        #expect(RequestCard.answered(unanswered) == nil)
    }

    /// A fresh answer opens with what the asker suggests already picked.
    @Test func whatTheAskerSuggestsIsAlreadyPicked() {
        let draft = QuestionDefaults.applied(to: AnswerDraft(sessionId: "s", requestId: "q", questions: Self.questions))
        #expect(draft.isPicked("SQLite", in: Self.questions[0]))
        #expect(!draft.isPicked("Postgres", in: Self.questions[0]))
        #expect(draft.isPicked("eu-west-1", in: Self.questions[1]) && draft.isPicked("us-east-1", in: Self.questions[1]))
        #expect(draft.other(for: Self.questions[2]) == "theme")
        #expect(draft.other(for: Self.questions[3]).isEmpty)
    }

    @Test func aCardNamesWhoAsks() {
        let request = TranscriptRow.Request(requestId: "q", tool: "", title: "", summary: "", state: .pending, questions: nil)
        #expect(Asker.name(request, agent: "codex") == "Codex")
        #expect(Asker.name(request, agent: "acp:gemini") == "Gemini")
        #expect(Asker.name(request, agent: "") == "The agent")
        let mcp = TranscriptRow.Request(requestId: "q", tool: "", title: "", summary: "", state: .pending, questions: nil,
                                        asker: "Linear's MCP server")
        #expect(Asker.name(mcp, agent: "claude") == "Linear's MCP server")
    }

    /// The dock holds the oldest request still waiting, and the answer on its way to it.
    @Test func theDockHoldsTheOldestRequestStillWaiting() {
        let request = { (id: String, state: RequestState) in
            TranscriptRow(key: "r:\(id)", seq: 1, content: .request(.init(requestId: id, tool: "Bash", title: "", summary: "", state: state,
                                                                          questions: nil)))
        }
        let transcript = Transcript(rows: [request("r0", .allowed), request("r1", .pending), request("r2", .pending)])
        var outbox = Outbox()
        #expect(PendingRequest.first(in: transcript, outbox: outbox)?.request.requestId == "r1")
        #expect(PendingRequest.first(in: transcript, outbox: outbox)?.answer == nil)
        let answer = OutgoingItem(sessionId: "s", payload: .answer(requestId: "r1", decision: .allow, answers: nil), afterSeq: 0)
        outbox.add(answer)
        #expect(PendingRequest.first(in: transcript, outbox: outbox)?.answer == answer)
        #expect(PendingRequest.first(in: Transcript(rows: [request("r0", .denied)]), outbox: outbox) == nil)
    }

    @Test func aQuestionThisIPhoneCannotAnswerSaysWhereItCanBe() {
        #expect(MacOnlyKind.words("branch") == "It picks a branch from the checkout on your Mac.")
        #expect(MacOnlyKind.words(nil) == "Realm on your Mac answers this kind of question.")
    }
}

@MainActor
@Suite("The composer, at rest and composing", .serialized)
struct ComposerDrawingTests {
    struct Host: View {
        @FocusState private var focused: Bool

        var body: some View {
            ComposerView(sessionId: "s1", focused: $focused)
        }
    }

    static func model() -> AppModel {
        let model = AppModel()
        model.store.finishOpening(OpenedSession(
            session: SessionRow(id: "s1", title: "T", spaceId: "sp", spaceName: "Realm", agent: "claude", model: "claude-opus-5-5",
                                status: .idle, needsYou: false, unread: false, updatedAt: 0, agentName: "Claude", agentMark: "claude",
                                modelLabel: "Opus 5.5"),
            rows: [], hasMore: false))
        return model
    }

    /// At rest it is one capsule, the field and its button: no line over it names the model.
    @Test func atRestItIsTheFieldAndItsButton() throws {
        let words = try Drawing.words(Host().environment(Self.model()))
        #expect(!words.contains("Opus"), "\(words)")
    }

    /// With words in it, it is a card, and the model the message goes to is a chip under them.
    @Test func composingTheModelIsAChipUnderTheWords() throws {
        let model = Self.model()
        model.composerDrafts["s1"] = "Ship it on Friday"
        let words = try Drawing.words(Host().environment(model))
        #expect(words.contains("Ship it on Friday") && words.contains("Opus 5.5"), "\(words)")
    }
}

@MainActor
@Suite("The composer's one button")
struct ComposerActionTests {
    static let photo = OutgoingAttachment(id: UUID(), name: "Photo.jpg", mime: "image/jpeg", size: 1_000, file: "x.jpg")

    /// Idle, it sends; with nothing to send it is there, and off.
    @Test func idleItSendsAndIsOffWithNothingToSend() {
        let off = ComposerAction(working: false, hasContent: false, midTurn: .queue, canSteer: true)
        #expect(off.kind == .send && !off.enabled && off.alternatives.isEmpty)
        let on = ComposerAction(working: false, hasContent: true, midTurn: .steer, canSteer: true)
        #expect(on.kind == .send && on.enabled && on.alternatives.isEmpty)
    }

    /// While a turn runs, or waits on the person, and nothing is typed, it stops the turn.
    @Test func midTurnWithNothingToSendItStops() {
        let stop = ComposerAction(working: true, hasContent: false, midTurn: .steer, canSteer: true)
        #expect(stop.kind == .stop && stop.enabled && stop.alternatives.isEmpty)
    }

    /// With something to send mid-turn it goes as the Mac takes a message then, and a long press offers
    /// the other way and Stop.
    @Test func midTurnItSendsAsTheMacTakesItWithTheOtherWayAndStopBeside() {
        let queue = ComposerAction(working: true, hasContent: true, midTurn: .queue, canSteer: true)
        #expect(queue.kind == .queue && queue.enabled && queue.alternatives == [.steer, .stop])
        let steer = ComposerAction(working: true, hasContent: true, midTurn: .steer, canSteer: true)
        #expect(steer.kind == .steer && steer.alternatives == [.queue, .stop])
        // A Mac that does not answer `session.options` never says what steering does: it is not offered.
        let older = ComposerAction(working: true, hasContent: true, midTurn: nil, canSteer: false)
        #expect(older.kind == .queue && older.alternatives == [.stop])
    }

    /// Words, or a file with none: something to send.
    @Test func wordsOrAFileAreSomethingToSend() {
        #expect(!ComposerAction.hasContent(text: "", attachments: []))
        #expect(!ComposerAction.hasContent(text: "  \n ", attachments: []))
        #expect(ComposerAction.hasContent(text: "Ship it", attachments: []))
        #expect(ComposerAction.hasContent(text: "", attachments: [Self.photo]))
    }

    /// Each sends as it says, and says what it does; Steer in the Mac's words for its agent.
    @Test func eachGoesAsItSays() {
        #expect(ComposerAction.delivery(.send) == .auto)
        #expect(ComposerAction.delivery(.queue) == .queue)
        #expect(ComposerAction.delivery(.steer) == .steer)
        #expect(ComposerAction.delivery(.stop) == nil)
        let note = "Sends now, into the turn Codex is already running. Nothing is interrupted."
        #expect(ComposerAction.Kind.queue.explanation(steerNote: note) == "Sends when this turn ends.")
        #expect(ComposerAction.Kind.steer.explanation(steerNote: note) == note)
        #expect(ComposerAction.Kind.stop.explanation(steerNote: note) == "Stops the agent's turn.")
        #expect(ComposerAction.Kind.allCases.map(\.symbol) == ["arrow.up", "stop.fill", "list.number", "arrow.turn.left.up"])
    }
}

@MainActor
@Suite("Marks, glyphs and colours")
struct MarkTests {
    @Test func aSpaceIconIsReadAsTheDesktopReadsIt() {
        #expect(SpaceIcon("emoji:🌊") == .emoji("🌊"))
        #expect(SpaceIcon("rocket") == .glyph("rocket"))
        #expect(SpaceIcon("hugeicon:rocket") == .glyph("rocket"))
        // A picture a Mac that sends no icon kind cannot send either; what the desktop falls back to
        // the folder for, so does the phone.
        #expect(SpaceIcon("asset:x1") == .glyph("folder"))
        #expect(SpaceIcon("emoji:") == .glyph("folder"))
        #expect(SpaceIcon("hugeicon:noSuchGlyph") == .glyph("folder"))
        #expect(SpaceIcon(nil) == .glyph("folder"))
        #expect(SpaceIcon("emoji:🌊").asset == nil)
    }

    /// A Mac that says what the icon is is taken at its word.
    @Test func aSpaceIconTheMacNamesIsTakenAtItsWord() {
        let space = { (kind: SpaceIconKind?, glyph: String?, emoji: String?, icon: JSONValue?) in
            Space(id: "s", name: "S", icon: icon, color: nil, sessions: [], more: 0, iconKind: kind, glyph: glyph, emoji: emoji)
        }
        #expect(SpaceIcon(space: space(.glyph, "rocket", nil, "rocket")) == .glyph("rocket"))
        #expect(SpaceIcon(space: space(.glyph, "noSuchGlyph", nil, nil)) == .glyph("folder"))
        #expect(SpaceIcon(space: space(.emoji, nil, "🦜", "emoji:🦜")) == .emoji("🦜"))
        #expect(SpaceIcon(space: space(.picture, nil, nil, "asset:x1")) == .picture)
        #expect(SpaceIcon.picture.asset == "Spaces/folder")
        // A Phase 1 Mac sends only the stored string.
        #expect(SpaceIcon(space: space(nil, nil, nil, "emoji:🌊")) == .emoji("🌊"))
    }

    @Test func everyMarkIsInTheCatalog() {
        for name in Marks.spaces { #expect(UIImage(named: "Spaces/\(name)") != nil, "Spaces/\(name)") }
        for icon in Marks.agentIcons { #expect(UIImage(named: "Agents/\(icon)") != nil, "Agents/\(icon)") }
        #expect(Set(Marks.agents.values).isSubset(of: Marks.agentIcons))
        #expect(UIImage(named: "RealmMark") != nil && UIImage(named: "RealmMarkShaded") != nil)
    }

    /// An agent wears the mark the Mac names, else its kind's, and never a guessed one.
    @Test func anAgentWearsItsVendorsMarkOrNone() {
        #expect(AgentMark.asset(kind: "claude") == "Agents/claude")
        #expect(AgentMark.asset(kind: "codex") == "Agents/openai")
        #expect(AgentMark.asset(kind: "acp:hermes") == "Agents/caduceus")
        #expect(AgentMark.asset(kind: "acp:newcomer", mark: "openai") == "Agents/openai")
        #expect(AgentMark.asset(kind: "claude", mark: "noSuchMark") == "Agents/claude")
        #expect(AgentMark.asset(kind: "acp:newcomer") == nil)
    }

    /// The desktop's own clamp, value for value: these are `spaceColor` in packages/ui/src/theme.ts.
    @Test func aSpaceColourReadsOnEachFaceAsOnTheMac() {
        let desktop: [(String, String, String)] = [
            ("#3b82f6", "#3b82f6", "#2473f5"), ("#10b981", "#2cedad", "#10b981"), ("#f59e0b", "#f6a723", "#f59e0b"),
            ("#1e1b4b", "#5d56c2", "#352f83"), ("#fef3c7", "#fde482", "#fbcf1e"), ("#808080", "#8c8c8c", "#808080"),
            ("#000000", "#8c8c8c", "#595959"), ("#fff", "#bfbfbf", "#8c8c8c"),
        ]
        for (stored, dark, light) in desktop {
            #expect(SpaceTint.hex(stored, dark: true) == dark, "\(stored) on the dark face")
            #expect(SpaceTint.hex(stored, dark: false) == light, "\(stored) on the light face")
        }
        #expect(SpaceTint.hex("teal", dark: true) == nil)
        #expect(SpaceTint.color("teal") == nil)
    }

    @Test func aSpaceColourIsReadFromItsHex() throws {
        func rgb(_ color: Color) -> [Int] {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
            return [r, g, b].map { Int(($0 * 255).rounded()) }
        }
        #expect(rgb(try #require(Color(hex: "#3b82f6"))) == [59, 130, 246])
        #expect(rgb(try #require(Color(hex: "#fff"))) == [255, 255, 255])
        #expect(Color(hex: "blue") == nil)
        #expect(Color(hex: "#12345") == nil)
    }

    /// The link's glyph and tone: green only when connected, red only where something failed.
    @Test func theLinkWearsItsStatesToneOnly() {
        #expect(LinkStatus.Kind.connected.tone == .done)
        #expect(LinkStatus.Kind.asleep(since: nil).tone == .quiet)
        #expect(LinkStatus.Kind.connecting.tone == .quiet)
        #expect(LinkStatus.Kind.relayUnreachable.tone == .failed)
        #expect(LinkStatus.Kind.asleep(since: nil).glyph == "moon.fill")
    }
}

@MainActor
@Suite("The app's own type, colour and categories")
struct AppResourceTests {
    @Test func theBundledMonoRegisteredAndNothingElseIsBundled() {
        #expect(RealmType.isInstalled)
        #expect(UIFont(name: RealmType.monoName, size: 17)?.familyName == "JetBrains Mono")
        // The interface is the system's face: Inter is no longer shipped.
        #expect(UIFont(name: "InterVariable", size: 17) == nil)
    }

    @Test func everyPaletteColourIsInTheCatalog() {
        let names = ["Page", "Canvas", "Surface", "Inset", "Hover", "Hover2", "Field", "Ink", "Ink2", "Ink3", "AccentColor", "AccentInk",
                     "AccentTint", "AccentFill", "AccentFillPress", "DangerFill", "Green", "GreenTint", "Orange", "OrangeTint", "Red", "RedTint",
                     "Line", "LineStrong", "Divider", "Mark"]
        for name in names { #expect(UIColor(named: name) != nil, "\(name) is missing from the asset catalog") }
        let dark = UITraitCollection(userInterfaceStyle: .dark), light = UITraitCollection(userInterfaceStyle: .light)
        #expect(UIColor(named: "Page")!.resolvedColor(with: dark) != UIColor(named: "Page")!.resolvedColor(with: light))
    }

    /// A filled control's white word clears 4.5:1 on its fill, on both faces (design.md); the bare
    /// accent is kept for marks that carry no word.
    @Test func theAccentFillCarriesAWhiteWord() {
        func luminance(_ color: UIColor) -> Double {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            let lin = { (c: CGFloat) -> Double in let c = Double(c); return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        }
        for style in [UIUserInterfaceStyle.dark, .light] {
            let fill = UIColor(named: "AccentFill")!.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            #expect(1.05 / (luminance(fill) + 0.05) >= 4.5, "white on the accent fill, \(style == .dark ? "dark" : "light")")
        }
    }

    /// The transcript stands on the canvas in dark and on the page's grey in light, so a white card
    /// on it still measures a step.
    @Test func theTranscriptGroundTakesEachFacesOwnRung() {
        let dark = UITraitCollection(userInterfaceStyle: .dark), light = UITraitCollection(userInterfaceStyle: .light)
        let ground = UIColor(Ground.transcript)
        #expect(ground.resolvedColor(with: dark) == UIColor(named: "Canvas")!.resolvedColor(with: dark))
        #expect(ground.resolvedColor(with: light) == UIColor(named: "Page")!.resolvedColor(with: light))
        #expect(UIColor(Fill.card).resolvedColor(with: light) != ground.resolvedColor(with: light))
    }

    @Test func everyKindOfPushHasACategory() {
        #expect(Set(NotificationKinds.categories.map(\.identifier)) == ["permission", "question", "finished", "failed", "blocked", "test"])
    }
}

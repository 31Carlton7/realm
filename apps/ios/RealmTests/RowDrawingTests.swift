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

@MainActor
@Suite("Every row of a transcript draws", .serialized)
struct RowDrawingTests {
    static func row(_ content: TranscriptRow.Content, key: String = "k:1") -> TranscriptRow {
        TranscriptRow(key: key, seq: 4, content: content)
    }

    static func words(_ content: TranscriptRow.Content, model: AppModel = AppModel(), dark: Bool = true) throws -> String {
        try Drawing.words(TranscriptRowView(row: row(content), sessionId: "s1").environment(model), dark: dark)
    }

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
        #expect(tool.contains("Bash") && tool.contains("pnpm test"))
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
        let permission = try Self.words(.request(.init(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test",
                                                       state: .pending, questions: nil)), dark: false)
        #expect(permission.contains("Allow Bash?") && permission.contains("Allow") && permission.contains("Deny"))
    }

    @Test func aPlanSaysHowFarAlongItIs() throws {
        let words = try Self.words(.plan(text: nil, steps: [PlanStep(text: "Carry the plan", status: "completed"),
                                                            PlanStep(text: "Draw it", status: "in_progress"),
                                                            PlanStep(text: "Test it", status: "pending")]))
        #expect(words.contains("1 of 3 done"))
    }

    @Test func aPermissionIsAnsweredInPlace() throws {
        let words = try Self.words(.request(.init(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test",
                                                   state: .pending, questions: nil)))
        #expect(words.contains("Allow Bash?"))
        #expect(words.contains("Waiting on you"))
        #expect(words.contains("Deny"))
    }

    /// Answered, the card stays as the question and its answer, with nothing left to press.
    @Test func anAnsweredPermissionKeepsItsWordsAndLosesItsButtons() throws {
        let words = try Self.words(.request(.init(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test",
                                                   state: .allowed, questions: nil)))
        #expect(words.contains("Allow Bash?") && words.contains("Allowed"))
        #expect(!words.contains("Deny"))
    }

    @Test func aPlanIsApprovedNotAllowed() throws {
        let words = try Self.words(.request(.init(requestId: "p1", tool: "ExitPlanMode", title: "Exit plan mode?",
                                                   summary: "Ship the mapper", state: .pending, questions: nil)))
        #expect(words.contains("Implement this plan"))
        #expect(words.contains("Keep planning"))
    }

    /// A card says who is asking first.
    @Test func aQuestionSaysWhoAsks() throws {
        let model = AppModel()
        model.store.finishOpening(OpenedSession(
            session: SessionRow(id: "s1", title: "T", spaceId: "sp", spaceName: "Site", agent: "codex", model: "gpt-6-luna",
                                status: .waiting, needsYou: true, unread: false, updatedAt: 0),
            rows: [], hasMore: false))
        let questions = [Question(question: "Which database should this use?", header: "Database", multiSelect: false,
                                  options: [QuestionOption(label: "SQLite", description: nil)])]
        let words = try Self.words(.request(.init(requestId: "q1", tool: "AskUserQuestion", title: "", summary: "",
                                                   state: .pending, questions: questions)), model: model)
        #expect(words.contains("Codex asks"))
        #expect(words.contains("Which database should this use?"))
        #expect(words.contains("Answer") && words.contains("Skip"))
    }

    /// An answer given while the Mac sleeps is kept, and the card says where it is.
    @Test func anAnswerWaitingForASleepingMacSaysSo() throws {
        let model = AppModel()
        model.store.finishOpening(OpenedSession(
            session: SessionRow(id: "s1", title: "T", spaceId: "sp", spaceName: "Realm", agent: "claude", model: nil, status: .waiting,
                                needsYou: true, unread: false, updatedAt: 0),
            rows: [], hasMore: false))
        model.store.connection = .macOffline(lastSeen: 1_790_000_000_000)
        let request = TranscriptRow.Request(requestId: "r1", tool: "Bash", title: "Allow Bash?", summary: "pnpm test", state: .pending,
                                            questions: nil)
        model.store.enqueueAnswer(.allow, to: "r1", in: "s1")
        let words = try Self.words(.request(request), model: model)
        #expect(words.contains("You allowed it"))
        #expect(words.contains("Your Mac is asleep"))
        #expect(words.contains("Don't send") || words.contains("Don’t send"))
    }

    /// A run of tool calls is one ledger, and every call in it is drawn.
    @Test func aLedgerDrawsEveryCall() throws {
        let rows = [Self.row(.tool(name: "Read", summary: "AppSettings.tsx", state: .done, detail: nil), key: "t1"),
                    Self.row(.tool(name: "Edit", summary: "AppSettings.tsx", state: .done, detail: nil), key: "t2"),
                    Self.row(.tool(name: "Bash", summary: "pnpm vitest", state: .running, detail: nil), key: "t3")]
        let words = try Drawing.words(WorkCard(rows: rows))
        #expect(words.contains("Read") && words.contains("Edit") && words.contains("Bash"))
    }
}

@MainActor
@Suite("A session on Home", .serialized)
struct SessionRowTests {
    static let row = SessionRow(id: "s1", title: "Add the dark-mode toggle", spaceId: "sp1", spaceName: "Realm", agent: "claude",
                                model: "claude-opus-5-5", status: .waiting, needsYou: true, unread: true,
                                updatedAt: 1_790_000_000_000)

    @Test func aRowDrawsItsTitleStatusAndModel() throws {
        let words = try Drawing.words(SessionRowView(row: Self.row, space: nil))
        #expect(words.contains("Add the dark-mode toggle"), "\(words)")
        #expect(words.contains("Waiting on you"), "\(words)")
        // JetBrains Mono's tailed l reads to Vision as a capital.
        #expect(words.lowercased().contains("claude-opus-5-5"), "\(words)")
    }

    /// At the largest accessibility size nothing shares a line with the title, and it all still draws.
    @Test func aRowStillReadsAtTheLargestSize() throws {
        let words = try Drawing.words(SessionRowView(row: Self.row, space: nil), size: .accessibility5)
        #expect(words.contains("Waiting on you"))
        #expect(words.contains("toggle"))
    }

    @Test func aRowSaysEverythingItShowsInWords() {
        let now = Date(timeIntervalSince1970: 1_790_000_120)
        #expect(SessionRowView.spoken(Self.row, now: now)
                == "Add the dark-mode toggle, Waiting on you, Unread, Realm, Claude, claude-opus-5-5, 2m ago")
        let quiet = SessionRow(id: "s2", title: "", spaceId: "sp1", spaceName: "Realm", agent: "codex", model: nil, status: .idle,
                               needsYou: false, unread: false, updatedAt: 1_790_000_000_000)
        #expect(SessionRowView.spoken(quiet, now: now) == "Untitled session, Idle, Realm, Codex, 2m ago")
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
@Suite("What Home lists")
struct HomeSectionsTests {
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

    @Test func withNoSearchEverythingIsListed() {
        let sections = HomeSections(home: Self.home, query: "  ")
        #expect(!sections.isFiltered)
        #expect(sections.needsYou.map(\.id) == ["c", "a"])
        #expect(sections.spaces.map(\.id) == ["realm", "site"])
        #expect(sections.spaces.first?.more == 2)
    }

    @Test func aSearchMatchesTheTitleTheSpaceAndTheAgent() {
        #expect(HomeSections(home: Self.home, query: "relay").spaces.flatMap(\.sessions).map(\.id) == ["b"])
        #expect(HomeSections(home: Self.home, query: "site").spaces.flatMap(\.sessions).map(\.id) == ["c"])
        #expect(HomeSections(home: Self.home, query: "Codex").needsYou.map(\.id) == ["c"])
        #expect(HomeSections(home: Self.home, query: "DARK").needsYou.map(\.id) == ["a"])
    }

    @Test func aSpaceWithNothingMatchingIsLeftOut() {
        let sections = HomeSections(home: Self.home, query: "relay")
        #expect(sections.spaces.map(\.id) == ["realm"])
        #expect(sections.needsYou.isEmpty)
        #expect(HomeSections(home: Self.home, query: "nothing like this").isEmpty)
    }

    @Test func aNeedsYouRowFindsItsSpace() {
        let sections = HomeSections(home: Self.home, query: "")
        #expect(sections.space(of: Self.home.needsYou[0])?.name == "Site")
        #expect(sections.space(of: Self.row("x", "T", space: "gone", spaceName: "Gone")) == nil)
    }
}

@MainActor
@Suite("How a transcript is laid out")
struct TranscriptLayoutTests {
    static func row(_ key: String, _ content: TranscriptRow.Content) -> TranscriptRow {
        TranscriptRow(key: key, seq: 1, content: content)
    }

    static let rows = [
        row("u1", .user(text: "Build it")),
        row("t1", .tool(name: "Read", summary: "a", state: .done, detail: nil)),
        row("k1", .thinking(text: "Hmm")),
        row("t2", .tool(name: "Edit", summary: "a", state: .done, detail: nil)),
        row("a1", .assistant(text: "Done", streaming: false)),
        row("t3", .tool(name: "Bash", summary: "test", state: .running, detail: nil)),
    ]

    @Test func aRunOfToolsAndThinkingIsOneLedger() {
        let items = TranscriptLayout.items(Self.rows)
        #expect(items.map(\.id) == ["u1", "work/t1", "a1", "work/t3"])
        guard case .work(let work) = items[1] else { Issue.record("the run is not a ledger"); return }
        #expect(work.map(\.key) == ["t1", "k1", "t2"])
    }

    @Test func everyRowIsDrawnOnceAndInOrder() {
        let keys = TranscriptLayout.items(Self.rows).flatMap { item -> [String] in
            switch item {
            case .row(let row): [row.key]
            case .work(let rows): rows.map(\.key)
            }
        }
        #expect(keys == Self.rows.map(\.key))
    }

    /// A ledger keeps its identity as its run grows, so it does not redraw from nothing with each call.
    @Test func aLedgerKeepsItsPlaceAsItGrows() {
        let before = TranscriptLayout.items(Array(Self.rows.prefix(2))).map(\.id)
        let after = TranscriptLayout.items(Array(Self.rows.prefix(4))).map(\.id)
        #expect(before == ["u1", "work/t1"])
        #expect(after == ["u1", "work/t1"])
    }
}

@MainActor
@Suite("The composer's buttons")
struct ComposerButtonsTests {
    @Test func sendIsUpOnlyWithSomethingToSend() {
        #expect(!ComposerButtons(working: false, draft: "").send)
        #expect(!ComposerButtons(working: false, draft: "  \n ").send)
        #expect(ComposerButtons(working: false, draft: "Ship it").send)
    }

    /// Stop stays while a turn runs, whatever is typed: a draft never hides it.
    @Test func stopStaysUpWhileATurnRunsWhateverIsTyped() {
        #expect(ComposerButtons(working: true, draft: "").stop)
        #expect(ComposerButtons(working: true, draft: "Ship it") == ComposerButtons(working: true, draft: "Also this"))
        #expect(ComposerButtons(working: true, draft: "Ship it").send)
        #expect(!ComposerButtons(working: false, draft: "Ship it").stop)
    }
}

@MainActor
@Suite("Marks, glyphs and colours")
struct MarkTests {
    @Test func aSpaceIconIsReadAsTheDesktopReadsIt() {
        #expect(SpaceIcon("emoji:🌊") == .emoji("🌊"))
        #expect(SpaceIcon("rocket") == .glyph("rocket"))
        #expect(SpaceIcon("hugeicon:rocket") == .glyph("rocket"))
        #expect(SpaceIcon("asset:x1") == .picture(id: "x1"))
        // What the desktop falls back to the folder for, so does the phone.
        #expect(SpaceIcon("emoji:") == .glyph("folder"))
        #expect(SpaceIcon("hugeicon:noSuchGlyph") == .glyph("folder"))
        #expect(SpaceIcon(nil) == .glyph("folder"))
        #expect(SpaceIcon("asset:x1").asset == "Spaces/folder")
        #expect(SpaceIcon("emoji:🌊").asset == nil)
    }

    @Test func everyMarkIsInTheCatalog() {
        for name in Marks.spaces { #expect(UIImage(named: "Spaces/\(name)") != nil, "Spaces/\(name)") }
        for icon in Set(Marks.agents.values) { #expect(UIImage(named: "Agents/\(icon)") != nil, "Agents/\(icon)") }
        #expect(UIImage(named: "RealmMark") != nil && UIImage(named: "RealmMarkShaded") != nil)
    }

    @Test func anAgentWearsItsVendorsMarkOrNone() {
        #expect(AgentMark.asset(for: "claude") == "Agents/claude")
        #expect(AgentMark.asset(for: "codex") == "Agents/openai")
        #expect(AgentMark.asset(for: "acp:hermes") == "Agents/caduceus")
        // A guessed mark would name the wrong vendor; the agent's name is beside it.
        #expect(AgentMark.asset(for: "acp:newcomer") == nil)
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
}

@MainActor
@Suite("What a request card says about the answer it holds")
struct AnswerWordsTests {
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

    @Test func aCardNamesWhoAsks() {
        #expect(RequestCard.asker("codex") == "Codex")
        #expect(RequestCard.asker("acp:gemini") == "Gemini")
        #expect(RequestCard.asker("") == "The agent")
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
                     "AccentTint", "Green", "GreenTint", "Orange", "OrangeTint", "Red", "RedTint", "Line", "LineStrong", "Divider", "Mark"]
        for name in names { #expect(UIColor(named: name) != nil, "\(name) is missing from the asset catalog") }
        let dark = UITraitCollection(userInterfaceStyle: .dark), light = UITraitCollection(userInterfaceStyle: .light)
        #expect(UIColor(named: "Page")!.resolvedColor(with: dark) != UIColor(named: "Page")!.resolvedColor(with: light))
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

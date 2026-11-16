import RealmKit
import SwiftUI
import Testing
@testable import Realm

/// The words and states of the audit's eighth fix: a call held up by a permission, an empty Review, the
/// pull request after a push, Realm's own relay, the question before iOS's notification prompt, a new
/// session's mode chip, and the Mac chip and Home's chips at the accessibility sizes.
@MainActor
@Suite("Words and states", .serialized)
struct WordingTests {
    static func tool(_ key: String, _ name: String = "Bash", _ state: ToolState = .running) -> TranscriptRow {
        TranscriptRow(key: key, seq: 1, content: .tool(name: name, summary: "pnpm db:migrate", state: state, detail: nil))
    }

    static func ask(_ tool: String = "Bash", _ state: RequestState = .pending) -> TranscriptRow {
        TranscriptRow(key: "r", seq: 2, content: .request(TranscriptRow.Request(requestId: "r1", tool: tool, title: "Allow \(tool)?",
                                                                               summary: "", state: state, questions: nil)))
    }

    /// The call a pending permission is about is the newest one of its tool still running before it.
    @Test func aPermissionHoldsUpTheCallItIsAbout() {
        #expect(ToolWords.waiting(in: [Self.tool("t1"), Self.tool("t2"), Self.ask()]) == ["t2"])
        #expect(ToolWords.waiting(in: [Self.tool("t1"), Self.ask("Bash", .allowed)]).isEmpty)
        #expect(ToolWords.waiting(in: [Self.tool("t1", "Edit"), Self.ask()]).isEmpty)
        #expect(ToolWords.waiting(in: [Self.tool("t1", "Bash", .done), Self.ask()]).isEmpty)
        #expect(ToolWords.waiting(in: [Self.ask(), Self.tool("t1")]).isEmpty)
    }

    /// While it waits on the person a call says so, in both faces, and is not drawn running.
    @Test func aHeldUpCallSaysItWaits() throws {
        let row = Self.tool("t1")
        for dark in [false, true] {
            let words = try Drawing.words(TranscriptRowView(row: row, sessionId: "s1").environment(AppModel())
                .environment(\.waitingTools, ["t1"]), dark: dark)
            #expect(words.contains("Waiting for you") && words.contains("migrate"), "\(words)")
            #expect(!words.contains("Running"), "\(words)")
        }
        let running = try Drawing.words(TranscriptRowView(row: row, sessionId: "s1").environment(AppModel()))
        #expect(running.contains("Running"), "\(running)")
    }

    /// Calls of one kind under one line say the same while the newest of them waits.
    @Test func aHeldUpRunOfCallsSaysItWaits() throws {
        let rows = [Self.tool("t1", "Bash", .done), Self.tool("t2")]
        let words = try Drawing.words(WorkRun(rows: rows, sessionId: "s1").environment(AppModel()).environment(\.waitingTools, ["t2"]))
        #expect(words.contains("Waiting for you") && !words.contains("Running"), "\(words)")
    }

    @Test func anEmptyReviewSaysWhatTheDesktopSays() {
        #expect(ReviewWords.empty == "Nobody is waiting on your review.")
    }

    /// The pull request a push opened is named by its number; its address is the link behind "Open on GitHub".
    @Test func aPushNamesThePullRequestByNumber() throws {
        let url = try #require(URL(string: "https://github.com/acme/realm/pull/42"))
        #expect(ShipWords.prOpened(url, created: true) == "Opened pull request #42.")
        #expect(ShipWords.prOpened(url, created: false) == "Pull request #42 is already open.")
        let other = try #require(URL(string: "https://git.example/acme/realm/merge_requests/7"))
        #expect(ShipWords.prOpened(other, created: true) == "Opened a pull request.")
        #expect(ShipWords.prOpened(other, created: false) == "A pull request is already open.")
    }

    /// Realm's own relays are "Realm's relay"; any other relay is still named, so a stranger's is plain.
    @Test func realmsRelayIsSaidInWords() throws {
        let link = try PairingLink.decode(PairingLink.url(relay: "wss://realm-relay.realm-relay.workers.dev", macId: PairingConfirmTests.macId,
                                                          macKey: Data(repeating: 2, count: 32), secret: Data(repeating: 3, count: 32),
                                                          windowId: Base64URL.encode(Data(repeating: 4, count: 16)), macName: "Studio", expiresAt: 1))
        let asked = PairConfirmation(link, replacing: nil)
        #expect(asked.message.contains("through Realm's relay."), "\(asked.message)")
        #expect(!asked.message.contains("workers.dev"))
    }

    /// Before iOS asks, Realm says what notifications are for; Not now stops launch from asking again.
    @Test func notificationsAreAskedForOnRealmsSheet() throws {
        let words = try Drawing.words(ConfirmSheet(title: NotificationAsk.title, message: NotificationAsk.message,
                                                   button: "Turn on", cancel: "Not now") {}, dark: false)
        for word in ["Turn on notifications", "waiting on you", "lock screen", "Not now", "Turn on"] {
            #expect(words.contains(word), "\(word) in \(words)")
        }
        let defaults = UserDefaults.standard
        let kept = defaults.object(forKey: AppModel.notificationsPutOffKey)
        defer { defaults.set(kept, forKey: AppModel.notificationsPutOffKey) }
        let model = AppModel()
        model.notificationAskShown = true
        model.putOffNotifications()
        #expect(!model.notificationAskShown)
        #expect(defaults.bool(forKey: AppModel.notificationsPutOffKey))
    }

    /// A new session's mode chip names the rung it will run on, as a session's chip does, and sends
    /// nothing for it unless another rung is picked.
    @Test func aNewSessionNamesItsRung() {
        let list = AgentList(agents: NewSessionTests.list.agents, defaultAgent: "claude", midTurn: .steer,
                             attachments: NewSessionTests.limits, teammatePermission: "default")
        let agent = NewSessionTests.list.agents[0]
        let options = NewSessionDefaults.options(agent, in: list)
        #expect(SettingWords.chip(options).label == "Ask each time")
        #expect(NewSessionDefaults.settings(options, resting: "default") == SessionChanges())
        let picked = options.applying(SessionChanges(permission: "acceptEdits"))
        #expect(NewSessionDefaults.settings(picked, resting: "default").permission == "acceptEdits")
        // A Mac too old to say its rung leaves the chip on the mode, as before.
        #expect(SettingWords.chip(NewSessionDefaults.options(agent, in: NewSessionTests.list)).label == "Build")
    }

    static let place = PlaceChip(label: "On Carlton's M4 MacBook Pro", short: "Mac", symbol: "laptopcomputer", open: {})

    /// At the accessibility sizes the place chip is the laptop and "Mac"; VoiceOver keeps the whole name.
    @Test func theMacChipIsShortAtTheAccessibilitySizes() throws {
        #expect(Self.place.spoken == "Where it runs, On Carlton's M4 MacBook Pro")
        #expect(Self.place.shown(at: .large) == "On Carlton's M4 MacBook Pro")
        let chips = SettingChips(label: "Opus 5.5", kind: "claude", mark: "claude", options: SettingWordsTests.options("default"),
                                 busy: false, openSettings: {}, place: Self.place) { _, _ in }
        for size in LargeTextTests.sizes {
            #expect(Self.place.shown(at: size) == "Mac")
            // Vision on iOS 26.5 reads the short word in Cyrillic lookalikes ("Мaс").
            let words = try Drawing.words(chips, width: LargeTextTests.chipsRow, dark: false, size: size)
                .replacingOccurrences(of: "М", with: "M").replacingOccurrences(of: "а", with: "a").replacingOccurrences(of: "с", with: "c")
            #expect(words.contains("Mac") && !words.contains("MacBook") && !words.contains("Carlton"), "\(size): \(words)")
            #expect(words.contains("Opus 5.5"), "\(size): \(words)")
        }
        let wide = try Drawing.words(chips, width: 700, dark: false, size: .large)
        #expect(wide.contains("MacBook Pro"), "\(wide)")
    }

    /// Home's chips grow with the text at the accessibility sizes and wrap rather than scroll, so every
    /// one is on screen.
    @Test func homesChipsGrowAtTheAccessibilitySizes() throws {
        // All alone never wraps, so only its words growing makes it taller.
        let all = HomeChips(filter: .constant(.all), needsYou: 0, pinned: 0).environment(AppModel())
        let allCapped = LargeTextTests.height(all, size: .xxxLarge)
        for size in LargeTextTests.sizes {
            #expect(LargeTextTests.height(all, size: size) > allCapped + 10, "\(size)")
        }
        let chips = HomeChips(filter: .constant(.all), needsYou: 2, pinned: 3).environment(AppModel())
        let capped = LargeTextTests.height(chips, size: .xxxLarge)
        for size in LargeTextTests.sizes {
            #expect(LargeTextTests.height(chips, size: size) > capped + 10, "\(size)")
            let words = try Drawing.words(chips, width: 370, dark: false, size: size)
            for word in ["All", "Needs", "Pinned"] {
                #expect(words.contains(word), "\(size): \(word) in \(words)")
            }
        }
    }
}

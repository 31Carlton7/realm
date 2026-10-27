import Observation
import PhotosUI
import RealmKit
import SwiftUI
import UIKit
import UserNotifications
import os

enum Route: Hashable {
    case session(String)
    /// A space's own page: all of its sessions, a page at a time.
    case space(String)
    /// Teams' open reviews, and one review's page.
    case reviews
    case review(String)
    case scheduled
    case usage
}

enum PairingStatus: Equatable {
    case idle
    case working(String)
    case confirmOnMac(String)
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .working, .confirmOnMac: true
        case .idle, .failed: false
        }
    }
}

/// Something that happened, said once and then gone; with `undo`, the one action that takes it back.
struct Toast: Equatable, Identifiable {
    let id = UUID()
    let text: String
    var undo: (@MainActor () -> Void)?

    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
}

/// Everything the screens act through: pairing, the connection to the Mac, the cache, what waits to
/// be sent, notifications and where the person is.
@MainActor
@Observable
final class AppModel {
    let store: RealmStore
    let diagnostics = Diagnostics()
    /// Review, Scheduled and Usage, and the sub-agents of the sessions opened here.
    let work = WorkModel()
    var path: [Route] = []
    /// Settings, in its sheet over Home.
    var settingsShown = false
    var pairing: PairingStatus = .idle
    /// Spaces' own pictures, by space, once fetched: `space.icon` is asked once per space a run.
    private(set) var spacePictures: [String: UIImage] = [:]
    /// Small copies of the pictures turns made, for their tiles, by session and path.
    private(set) var thumbnails: [String: UIImage] = [:]
    /// What each turn changed, by its checkpoint, once asked.
    private(set) var turnChanges: [String: TurnChanges] = [:]
    /// When each session's turn began, where this phone saw it begin: a turn already running when the
    /// session opened has no start this phone can vouch for, so it shows no clock.
    private(set) var workingSince: [String: Date] = [:]
    /// The simulators and machines in each opened session's space, as the Mac last said. A session whose
    /// Mac has no such call is absent, and its bar has no Screens button.
    private(set) var sessionScreens: [String: [SessionScreen]] = [:]
    /// When a row first arrived live, by its key; rows that came with the session's opening have none.
    @ObservationIgnored private(set) var rowBirths: [String: Date] = [:]
    var toast: Toast?
    /// A pairing link for a different Mac, waiting for the person to say it replaces this one.
    var replacingPairLink: String?
    /// What is typed in each session's composer and not sent yet: leaving a session keeps it.
    var composerDrafts: [String: String] = [:]
    /// The files in each session's composer, not sent yet: leaving a session keeps them, as it keeps
    /// the words.
    private(set) var draftAttachments: [String: [OutgoingAttachment]] = [:]
    /// Picked for a session's composer, and still being read or made smaller.
    private(set) var preparingAttachments: [String: Int] = [:]
    /// Each session's settings and what they could be, as its Mac last said: what the composer's chips
    /// show. Asked when the session opens, and again when its settings sheet does.
    private(set) var sessionOptions: [String: SessionOptions] = [:]
    /// Sessions whose Mac has no `session.options`, being older: their settings sheet says to update it.
    private(set) var optionsUnanswered: Set<String> = []
    /// The setting a change is on its way to the Mac for, by session.
    private(set) var configuring: [String: SessionSetting] = [:]
    /// What the person changed about sessions' rows here — a rename, a pin, an archive — shown over what
    /// the Mac lists until it lists them so.
    var rowEdits = RowEdits()
    /// The Rename alert, while it is up: the session, and the title in its field.
    var renaming: RenameDraft?
    /// The agents a new session could be given, as the Mac last said; nil until it answers `agents.list`,
    /// and Home's compose button with it.
    var agentList: AgentList?
    /// The queued messages a Send now, an edit or a removal is on its way to the Mac for, by session.
    var queueCalls: [String: Set<String>] = [:]
    /// The person asked to pair again over the Mac this phone shows (after the Mac removed it).
    var pairingRequested = false
    /// The profile Home shows, as the person last chose it for this Mac; nil until they choose.
    private(set) var keptProfile: ProfileChoice?
    private(set) var notificationStatus: UNAuthorizationStatus = .notDetermined
    /// Goes up with every new channel. Open sessions open again, since a subscription does not
    /// outlive the channel it was made on.
    private(set) var channelGeneration = 0

    @ObservationIgnored let log = Logger(subsystem: "co.charmtechnologies.realm.ios", category: "app")
    @ObservationIgnored let courier: Courier
    @ObservationIgnored private let vault = Vault(store: KeychainStore())
    @ObservationIgnored private var identity: DeviceIdentity?
    @ObservationIgnored private(set) var connection: MobileConnection?
    @ObservationIgnored private var listeners: [Task<Void, Never>] = []
    @ObservationIgnored private var pushRegistration: PushRegistration?
    @ObservationIgnored private var launched = false
    @ObservationIgnored private var autoDiagnosticsStarted = false
    @ObservationIgnored private var pendingSession: String?
    @ObservationIgnored private var cache: RealmCache?
    /// Every write to the cache, in the order it was made: a later outbox must never be overwritten by
    /// an earlier one still on its way to disk.
    @ObservationIgnored private let disk = DispatchQueue(label: "co.charmtechnologies.realm.ios.cache", qos: .utility)
    /// Sessions on screen: their rows are live and kept.
    @ObservationIgnored private var visibleSessions: Set<String> = []
    @ObservationIgnored private var saveTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var retryTasks: [String: Task<Void, Never>] = [:]
    /// Pictures and changes asked for, so a redraw does not ask again while the first is on its way.
    @ObservationIgnored private var askedPictures: Set<String> = []
    @ObservationIgnored private var askedChanges: Set<String> = []
    /// The previews the Mac made of files turns made, the newest few kept so a tile and its sheet ask once.
    @ObservationIgnored private var previews: [String: FilePreview] = [:]
    @ObservationIgnored private var previewOrder: [String] = []
    @ObservationIgnored private var askedThumbnails: Set<String> = []
    /// Home is asked for again on every change the Mac reports and every switch of profile: these
    /// count the asks, and the last answered, so an answer overtaken by a later one is not shown.
    @ObservationIgnored private(set) var homeAsks = 0
    @ObservationIgnored private var homeShown = 0
    /// Each session's row changes on their way to the Mac, one after another, so an Undo never overtakes
    /// the archive it takes back.
    @ObservationIgnored var rowChanges: [String: Task<Void, Never>] = [:]

    init() {
        let store = RealmStore()
        self.store = store
        courier = Courier(store: store)
        courier.onAccepted = { item in
            // An answer confirms when the Mac takes it, never when the button is pressed.
            if case .answer = item.payload { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        }
        work.api = { [weak self] in self?.isConnected == true ? self?.api : nil }
    }

    var api: MobileAPI? { connection.map(MobileAPI.init) }
    var isConnected: Bool { store.connection.isConnected }
    var linkStatus: LinkStatus { store.linkStatus() }

    /// The link as the screen says it. Once connected, a drop says nothing until it has lasted 800 ms,
    /// so a blip never moves anything; before the first connection, the attempt is the news.
    var shownLinkStatus: LinkStatus {
        let actual = linkStatus
        if actual.isConnected || linkTroubled || !everConnected { return actual }
        return LinkStatus(.connected)
    }

    /// The Mac and its state, for the line under a title: "MacBook Pro · Asleep since 10:42".
    var macLine: String {
        [store.pairedMac?.macName, shownLinkStatus.words].compactMap { $0 }.joined(separator: " · ")
    }

    /// The link has been down for 800 ms, long enough to be worth saying.
    private(set) var linkTroubled = false
    @ObservationIgnored private var everConnected = false
    @ObservationIgnored private var troubleTimer: Task<Void, Never>?

    private func noteLink(_ state: ConnectionState) {
        if state.isConnected {
            everConnected = true
            troubleTimer?.cancel()
            troubleTimer = nil
            linkTroubled = false
        } else if troubleTimer == nil, !linkTroubled {
            troubleTimer = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(800))
                guard let self, !Task.isCancelled else { return }
                self.linkTroubled = true
                self.troubleTimer = nil
            }
        }
    }

    // MARK: - Launch and pairing

    func launch() async {
        guard !launched, !LaunchOptions.hostingUnitTests else { return }
        launched = true
        UNUserNotificationCenter.current().setNotificationCategories(NotificationKinds.categories)
        do {
            identity = try vault.loadOrCreateIdentity()
        } catch {
            pairing = .failed("This iPhone's keys could not be read from the keychain. \(error.localizedDescription)")
            return
        }
        if let mac = (try? vault.pairedMacs())?.last { adopt(mac) }
        // Never waited on: the system can be slow to answer, and nothing at launch depends on it.
        Task { await refreshNotificationStatus() }
        if let link = LaunchOptions.pairLink {
            let window = try? PairingLink.decode(link).windowId
            if store.pairedMac?.windowId != window {
                await pair(with: link)
                return
            }
        }
        if store.pairedMac != nil {
            connect()
            registerForPushes()
        }
        if let session = pendingSession ?? LaunchOptions.openSession {
            pendingSession = nil
            show(session: session)
        }
    }

    /// Takes a Mac as the one this phone shows, with whatever was kept of it.
    private func adopt(_ mac: PairedMac) {
        store.pairedMac = mac
        let cache = RealmCache(root: RealmCache.defaultRoot(), macId: mac.macId)
        self.cache = cache
        if let home = cache.loadHome() { store.restoreHome(home) }
        store.restoreOutbox(cache.loadOutbox())
        keptProfile = UserDefaults.standard.string(forKey: Self.profileKey(mac.macId)).flatMap(ProfileChoice.init(stored:))
    }

    /// Where the profile chosen for a Mac is kept: on the phone, one key per Mac.
    private static func profileKey(_ macId: String) -> String { "home.profile.\(macId)" }

    private func forgetProfile(of macId: String) {
        UserDefaults.standard.removeObject(forKey: Self.profileKey(macId))
        keptProfile = nil
    }

    /// A link the system handed the app: the scheme, a Universal Link, or a code the scanner read.
    func open(url: URL) {
        open(pairingText: url.absoluteString)
    }

    func open(pairingText text: String) {
        guard let link = try? PairingLink.decode(text) else {
            show(toast: "That is not a Realm pairing link.")
            return
        }
        if let paired = store.pairedMac {
            if paired.macId == link.macId && paired.windowId == link.windowId { return }
            // Settings makes way: what comes next is asked over Home.
            settingsShown = false
            if paired.macId != link.macId {
                replacingPairLink = text
                return
            }
        }
        Task { await pair(with: text) }
    }

    func pair(with text: String) async {
        guard let identity, !pairing.isBusy else { return }
        let link: PairingLink
        do {
            link = try PairingLink.parse(text)
        } catch {
            pairing = .failed(Self.describe(error))
            return
        }
        pairing = .working("Reaching \(link.macName)…")
        let device = PairingDevice(name: DeviceInfo.name, model: DeviceInfo.model)
        do {
            let mac = try await Pairing.run(link: link, identity: identity, device: device) { [weak self] progress in
                Task { @MainActor in self?.pairingProgressed(progress) }
            }
            try vault.save(mac)
            log.info("Paired with \(mac.macName, privacy: .public) as \(mac.phoneId, privacy: .public)")
            print("[realm] paired with \(mac.macName) as \(mac.phoneId)")
            let previous = store.pairedMac
            disconnect()
            if let previous, previous.macId != mac.macId {
                // One Mac at a time: the one this replaces is forgotten here, as Forget would.
                try? vault.removeMac(id: previous.macId)
                if let cache { disk.async { try? cache.removeAll() } }
                forgetProfile(of: previous.macId)
            }
            store.forgetEverything()
            forgetFetched()
            adopt(mac)
            path = []
            settingsShown = false
            pairing = .idle
            pairingRequested = false
            connect()
            registerForPushes()
        } catch {
            pairing = .failed(Self.describe(error))
            print("[realm] pairing failed: \(error)")
        }
    }

    private func pairingProgressed(_ progress: PairingProgress) {
        guard pairing.isBusy else { return }
        switch progress {
        case .connecting: break
        case .confirmOnMac(let macName): pairing = .confirmOnMac(macName)
        }
    }

    /// Forgets the Mac on this phone only: its keys, its pairing and everything kept of it. The Mac
    /// still lists this iPhone until it is removed there.
    func forgetMac() {
        guard let mac = store.pairedMac else { return }
        disconnect()
        try? vault.removeMac(id: mac.macId)
        if let cache { disk.async { try? cache.removeAll() } }
        cache = nil
        forgetProfile(of: mac.macId)
        store.forgetEverything()
        forgetFetched()
        store.pairedMac = nil
        store.connection = .idle
        path = []
        settingsShown = false
        pairing = .idle
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
    }

    // MARK: - The connection

    func connect() {
        guard let mac = store.pairedMac, let identity else { return }
        disconnect()
        let connection = MobileConnection(mac: mac, identity: identity,
                                          client: ClientInfo(app: DeviceInfo.appVersion, os: DeviceInfo.osVersion))
        self.connection = connection
        listeners = [
            Task { [weak self] in
                for await state in connection.states { self?.connectionChanged(state) }
            },
            Task { [weak self] in
                for await event in connection.events { self?.received(event) }
            },
        ]
        let registration = pushRegistration
        Task {
            if let registration { await connection.setPushRegistration(registration) }
            await connection.start()
        }
    }

    func disconnect() {
        for listener in listeners { listener.cancel() }
        listeners = []
        for task in retryTasks.values { task.cancel() }
        retryTasks = [:]
        if let connection { Task { await connection.stop() } }
        connection = nil
        store.connection = .stopped
        noteLink(.stopped)
        store.markStale()
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            if store.pairedMac != nil, connection == nil, launched { connect() }
            Task { await refreshNotificationStatus() }
        case .background:
            saveEverything()
            // iOS suspends a backgrounded app; closing first lets the relay and the Mac see it go.
            guard !LaunchOptions.autoDiagnostics else { return }
            if store.outbox.items.contains(where: { $0.state == .sending }) {
                finishSendingThenDisconnect()
            } else {
                disconnect()
            }
        default:
            break
        }
    }

    /// Something is on its way as the app leaves: give it a few seconds to land before the channel
    /// closes. Whatever has not, stays in the outbox and is looked for on return.
    private func finishSendingThenDisconnect() {
        let application = UIApplication.shared
        let task = BackgroundTask()
        task.id = application.beginBackgroundTask(withName: "Finish sending") {
            application.endBackgroundTask(task.id)
        }
        Task {
            let deadline = ContinuousClock.now + .seconds(10)
            while store.outbox.items.contains(where: { $0.state == .sending }), ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(200))
            }
            saveOutbox()
            if UIApplication.shared.applicationState == .background { disconnect() }
            application.endBackgroundTask(task.id)
        }
    }

    /// Pull to refresh: Home again, or a new attempt now rather than at the end of the backoff.
    func refresh() async {
        if isConnected {
            await refreshHome()
            return
        }
        guard store.pairedMac != nil else { return }
        connect()
        let deadline = ContinuousClock.now + .seconds(8)
        while !isConnected, ContinuousClock.now < deadline, connection != nil {
            if case .refused = store.connection { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private func connectionChanged(_ state: ConnectionState) {
        let wasConnected = store.connection.isConnected
        store.connection = state
        noteLink(state)
        print("[realm] connection: \(state)")
        if wasConnected && !state.isConnected { store.markStale() }
        guard case .connected(let mac) = state else { return }
        store.latency.handshake = mac.handshake
        store.latency.connect = mac.connect
        if var paired = store.pairedMac {
            let moved = paired.moved(to: mac.relay)
            if let moved { paired = moved }
            paired.macName = mac.name
            if paired != store.pairedMac {
                store.pairedMac = paired
                try? vault.save(paired)
            }
            // The Mac is on another relay now (PROTOCOL.md §3.3): kept, and dialled from here on. The
            // reconnect is one handshake, inside the 800 ms a drop goes unsaid (`shownLinkStatus`).
            if let moved {
                log.info("Following \(mac.name, privacy: .public) to \(moved.relay.absoluteString, privacy: .public)")
                connect()
                return
            }
        }
        channelGeneration += 1
        Task {
            await refreshHome()
            await work.refresh()
            await deliverOutsideOpenSessions()
        }
        Task { await loadAgents() }
        if LaunchOptions.autoDiagnostics, !autoDiagnosticsStarted {
            autoDiagnosticsStarted = true
            Task {
                // Home names the session Diagnostics opens when no `-diagnosticsSession` is given.
                await refreshHome()
                await diagnostics.run(using: self, sendReport: true)
            }
        }
    }

    private func received(_ event: MobileEvent) {
        let outbox = store.outbox
        noteArrivals(event)
        store.apply(event)
        if store.outbox != outbox { saveOutbox() }
        switch event {
        case .homeChanged:
            Task { await refreshHome() }
            // A scheduled run's session read, here or on the Mac, is not an unread result any more.
            Task { await work.refresh() }
        case .workChanged:
            Task { await work.refresh() }
        case .sessionSubagents(let id) where visibleSessions.contains(id):
            Task { await work.loadSubagents(id) }
        case .sessionRows(let update) where visibleSessions.contains(update.id):
            saveTranscriptSoon(update.id)
        default:
            break
        }
    }

    /// Rows that arrive live, and turns this phone saw start: a row born a moment ago is the one that
    /// may move into place, and a turn's clock runs only from a start this phone saw.
    private func noteArrivals(_ event: MobileEvent) {
        switch event {
        case .sessionRows(let update):
            guard let before = store.transcripts[update.id] else { return }
            let now = Date()
            for row in update.rows where before.row(forKey: row.key) == nil { rowBirths[row.key] = now }
        case .sessionStatus(let update):
            let was = store.transcripts[update.id]?.status
            if update.status == .running {
                if was != .running { workingSince[update.id] = Date() }
            } else {
                workingSince[update.id] = nil
            }
        default:
            break
        }
    }

    // MARK: - Home

    /// The profile Home shows: the one kept for this Mac while it still has it, else its first. Until
    /// the Mac has said which profiles it has, the one kept, or all of them.
    var profileChoice: ProfileChoice {
        guard let home = store.home else { return keptProfile ?? .all }
        return ProfileChoice.resolve(keptProfile, in: home)
    }

    /// Shows another profile, from the title's menu or a line saying what needs the person there. What
    /// Home holds lists it at once; its recent sessions are asked of the Mac.
    func choose(_ choice: ProfileChoice) {
        guard let mac = store.pairedMac else { return }
        let before = profileChoice
        keptProfile = choice
        UserDefaults.standard.set(choice.stored, forKey: Self.profileKey(mac.macId))
        if profileChoice != before { Task { await refreshHome() } }
    }

    func refreshHome() async {
        guard let api, isConnected else { return }
        homeAsks += 1
        let ask = homeAsks
        let profileId = profileChoice.profileId
        do {
            let home = try await api.home(profileId: profileId)
            guard ask > homeShown else { return }
            homeShown = ask
            store.showHome(home)
            rowEdits.caughtUp(with: home, ask: ask)
            if let cache { disk.async { try? cache.saveHome(home) } }
            // The badge says what Needs you says: the same moments the Mac's pushes are for.
            try? await UNUserNotificationCenter.current().setBadgeCount(home.needsYou.count)
            // A Mac's first answer names its profiles, and with them the one shown by default: its own
            // recent sessions are asked for, unless a later ask is already on its way.
            if profileChoice.profileId != profileId, ask == homeAsks { await refreshHome() }
        } catch {
            report(error)
        }
    }

    /// One page of a space's sessions, the newest activity first.
    func spaceSessions(_ spaceId: String, from offset: Int) async throws -> SpaceSessions {
        guard let api, isConnected else { throw ChannelError.notConnected }
        return try await api.spaceSessions(id: spaceId, offset: offset, limit: SpacePages.size)
    }

    /// What Diagnostics opens when it is not told which: an idle session, since a message sent to one
    /// that is waiting on a permission is held in the Mac's queue and never echoes in time.
    var diagnosticsSessionId: String? {
        let sessions = (store.home?.spaces ?? []).flatMap(\.sessions)
        return (sessions.first { $0.status == .idle } ?? sessions.first { $0.status != .waiting } ?? sessions.first)?.id
    }

    // MARK: - A session

    func open(_ sessionId: String) async {
        visibleSessions.insert(sessionId)
        if store.transcripts[sessionId] == nil, let cached = cache?.loadTranscript(sessionId) {
            store.restoreTranscript(sessionId, from: cached)
        }
        guard let api, isConnected else { return }
        Task { await work.loadSubagents(sessionId) }
        Task {
            await loadOptions(sessionId)
            #if DEBUG
            await stageLaunchPhoto(in: sessionId)
            #endif
        }
        store.beginOpening(sessionId)
        do {
            store.finishOpening(try await api.openSession(id: sessionId))
            saveTranscript(sessionId)
            await deliver(sessionId)
        } catch {
            store.cancelOpening(sessionId)
            report(error)
        }
    }

    func close(_ sessionId: String) async {
        visibleSessions.remove(sessionId)
        saveTranscript(sessionId)
        store.closeSession(sessionId)
        saveOutbox()
        guard let api, isConnected else { return }
        try? await api.closeSession(id: sessionId)
    }

    /// A message, in line behind anything already waiting, with the files it takes and what it does if
    /// a turn is under way when it arrives. It shows as Sending… until the Mac has it.
    func send(_ text: String, attachments: [OutgoingAttachment] = [], delivery: Delivery = .auto, to sessionId: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return }
        store.enqueueMessage(text, attachments: attachments, delivery: delivery, in: sessionId)
        saveOutbox()
        Task { await deliver(sessionId) }
    }

    /// Sends what is in a session's composer, words and files, and empties it.
    func sendDraft(_ sessionId: String, delivery: Delivery) {
        let text = composerDrafts[sessionId] ?? "", attachments = draftAttachments[sessionId] ?? []
        guard ComposerAction.hasContent(text: text, attachments: attachments) else { return }
        send(text, attachments: attachments, delivery: delivery, to: sessionId)
        composerDrafts[sessionId] = nil
        draftAttachments[sessionId] = nil
    }

    func answer(_ decision: Decision, to request: TranscriptRow.Request, in sessionId: String) {
        guard store.enqueueAnswer(decision, to: request.requestId, in: sessionId) != nil else { return }
        saveOutbox()
        Task { await deliver(sessionId) }
    }

    func submit(_ draft: AnswerDraft) {
        guard store.submit(draft) != nil else { return }
        saveOutbox()
        Task { await deliver(draft.sessionId) }
    }

    func retry(_ item: OutgoingItem) {
        store.retryOutgoing(item.id)
        saveOutbox()
        Task { await deliver(item.sessionId) }
    }

    func discard(_ item: OutgoingItem) {
        store.discardOutgoing(item.id)
        saveOutbox()
    }

    func stop(_ sessionId: String) async {
        guard let api, isConnected else {
            if case .asleep = linkStatus.kind {
                show(toast: "Your Mac is asleep, so Stop cannot reach it.")
            } else {
                show(toast: "Stop needs a connection to your Mac.")
            }
            return
        }
        do {
            try await api.stop(id: sessionId)
        } catch {
            report(error)
        }
    }

    // MARK: - Screens

    /// What a session's space has open to watch. Asked again whenever its bar is drawn anew — the
    /// session opened, its turn started or ended, the Mac came back — since a turn is what opens one.
    func loadScreens(_ sessionId: String) async {
        guard let api, isConnected else { return }
        do {
            sessionScreens[sessionId] = try await api.screens(id: sessionId)
        } catch ChannelError.rpc(let error) where error.code == "METHOD_NOT_FOUND" {
            sessionScreens[sessionId] = nil
        } catch {
            // The button keeps what it last knew.
        }
    }

    /// One picture of a screen in a session's space.
    func screenFrame(_ screen: SessionScreen, in sessionId: String, maxSide: Int) async throws -> ScreenFrame {
        guard let api, isConnected else { throw ChannelError.notConnected }
        return try await api.screen(id: sessionId, screen: screen, maxSide: maxSide)
    }

    // MARK: - The composer

    /// A session's settings and what they could be. A Mac before Plan 29 has no such call; its
    /// sessions are noted, and their composer takes no files.
    func loadOptions(_ sessionId: String) async {
        guard let api, isConnected else { return }
        do {
            sessionOptions[sessionId] = try await api.options(id: sessionId)
            optionsUnanswered.remove(sessionId)
        } catch ChannelError.rpc(let error) where error.code == "METHOD_NOT_FOUND" {
            optionsUnanswered.insert(sessionId)
        } catch {
            // The chips keep what they last knew, and the sheet asks again when it opens.
        }
    }

    /// One change to a session's settings: shown at once, then as the Mac has it, or put back with a
    /// toast where it refuses. One at a time, so putting one back never undoes a later one: the
    /// settings sheet and the mode chip are off while one travels.
    func configure(_ changes: SessionChanges, _ setting: SessionSetting, in sessionId: String) async {
        guard configuring[sessionId] == nil, let before = sessionOptions[sessionId] else { return }
        guard let api, isConnected else {
            show(toast: "Connect to your Mac to change these.")
            return
        }
        configuring[sessionId] = setting
        sessionOptions[sessionId] = before.applying(changes)
        do {
            sessionOptions[sessionId] = try await api.configure(id: sessionId, changes)
        } catch {
            sessionOptions[sessionId] = before
            show(toast: "\(setting.word) did not change. \(Self.describe(error))")
        }
        configuring[sessionId] = nil
    }

    /// Adds what was picked to a composer's draft — a session's, or a new session's under its own key —
    /// each made ready and kept on this phone until it is sent or taken out: a photo made a JPEG, a file
    /// read whole. What the Mac would refuse, by `limits` or the session's own, is left out, and a toast
    /// says why.
    func attach(_ sources: [AttachmentSource], to sessionId: String, limits: SendLimits? = nil) async {
        guard let limits = limits ?? sessionOptions[sessionId]?.attachments, !sources.isEmpty else { return }
        preparingAttachments[sessionId, default: 0] += sources.count
        for source in sources {
            let name = AttachmentNames.photo(besides: draftAttachments[sessionId] ?? [])
            let outcome = await Task.detached(priority: .userInitiated) { await Self.prepare(source, photoName: name, limits: limits) }.value
            let left = (preparingAttachments[sessionId] ?? 1) - 1
            preparingAttachments[sessionId] = left > 0 ? left : nil
            let prepared: PreparedFile
            switch outcome {
            case .success(let file): prepared = file
            case .failure(let refusal):
                show(toast: refusal.words)
                continue
            }
            let taken = draftAttachments[sessionId] ?? []
            if let refusal = AttachmentLimits.refusal(prepared.name, size: prepared.data.count, joining: taken, limits: limits) {
                show(toast: refusal)
                continue
            }
            do {
                draftAttachments[sessionId, default: []].append(try store.files.keep(prepared.data, name: prepared.name, mime: prepared.mime))
            } catch {
                show(toast: "\(prepared.name) could not be kept on this iPhone. \(error.localizedDescription)")
            }
        }
    }

    #if DEBUG
    @ObservationIgnored private var photoStaged = false

    /// `-stagePhoto <path>`: the picture, in the first session's composer that opens.
    private func stageLaunchPhoto(in sessionId: String) async {
        guard !photoStaged, let path = LaunchOptions.stagedPhoto, let image = UIImage(contentsOfFile: path) else { return }
        photoStaged = true
        await attach([.camera(image)], to: sessionId)
    }
    #endif

    /// Takes a file out of a session's composer, and off this phone.
    func removeAttachment(_ attachment: OutgoingAttachment, from sessionId: String) {
        draftAttachments[sessionId]?.removeAll { $0.id == attachment.id }
        store.files.remove([attachment])
    }

    /// A picked photo or file, ready to keep; or why it cannot go, in words. Off the main thread: a
    /// photo takes a moment to make smaller, and a file to read.
    private nonisolated static func prepare(_ source: AttachmentSource, photoName: String, limits: SendLimits) async -> Result<PreparedFile, Refusal> {
        switch source {
        case .library(let item):
            guard let data = try? await item.loadTransferable(type: Data.self), let jpeg = PhotoPrep.jpeg(data) else {
                return .failure(Refusal(words: "That photo could not be read."))
            }
            return .success(PreparedFile(data: jpeg, name: photoName, mime: "image/jpeg"))
        case .camera(let image):
            guard let jpeg = PhotoPrep.jpeg(image) else { return .failure(Refusal(words: "That photo could not be read.")) }
            return .success(PreparedFile(data: jpeg, name: photoName, mime: "image/jpeg"))
        case .file(let url):
            let name = url.lastPathComponent
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            // Refused before it is read: a film from Files can be far larger than the phone should hold at once.
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > limits.maxBytes {
                return .failure(Refusal(words: AttachmentLimits.refusal(name, size: size, joining: [], limits: limits) ?? ""))
            }
            guard let data = try? Data(contentsOf: url) else { return .failure(Refusal(words: "\(name) could not be read.")) }
            let file = FilePrep.prepared(data, name: name)
            return .success(PreparedFile(data: file.data, name: file.name, mime: file.mime))
        }
    }

    private struct PreparedFile: Sendable {
        let data: Data
        let name: String
        let mime: String
    }

    private struct Refusal: Error {
        let words: String
    }

    /// Marks the session read up to its last row, once that row has been on screen.
    func markSeen(_ sessionId: String) {
        guard let api, isConnected, let seq = store.seenToMark(sessionId) else { return }
        store.markedSeen(sessionId, upTo: seq)
        Task {
            do {
                try await api.seen(id: sessionId, seq: seq)
            } catch {
                store.forgetSeen(sessionId)
            }
        }
    }

    // MARK: - What a turn left

    /// A turn's changed files, asked of the Mac once and kept for the run.
    func loadChanges(_ checkpointId: String, in sessionId: String) async {
        guard turnChanges[checkpointId] == nil, !askedChanges.contains(checkpointId), let api, isConnected else { return }
        askedChanges.insert(checkpointId)
        do {
            turnChanges[checkpointId] = try await api.changes(id: sessionId, checkpointId: checkpointId)
        } catch {
            askedChanges.remove(checkpointId)
        }
    }

    /// One page of a changed file's patch.
    func diff(_ path: String, at checkpointId: String, in sessionId: String, from: Int = 0) async throws -> DiffPage {
        guard let api, isConnected else { throw ChannelError.notConnected }
        return try await api.diff(id: sessionId, checkpointId: checkpointId, path: path, from: from)
    }

    /// What the phone may see of a file a turn made, asked of the Mac once while it is kept.
    func preview(_ path: String, in sessionId: String) async throws -> FilePreview {
        let key = Self.previewKey(path, sessionId)
        if let kept = previews[key] { return kept }
        guard let api, isConnected else { throw ChannelError.notConnected }
        let preview = try await api.file(id: sessionId, path: path)
        previews[key] = preview
        previewOrder.removeAll { $0 == key }
        previewOrder.append(key)
        while previewOrder.count > Self.previewsKept { previews[previewOrder.removeFirst()] = nil }
        return preview
    }

    /// A picture a turn made, small enough for its tile.
    func loadThumbnail(_ path: String, in sessionId: String, side: CGFloat) async {
        let key = Self.previewKey(path, sessionId)
        guard thumbnails[key] == nil, !askedThumbnails.contains(key), isConnected else { return }
        askedThumbnails.insert(key)
        guard let preview = try? await preview(path, in: sessionId), case .image(_, let data) = preview.preview,
              let image = UIImage(data: data) else {
            askedThumbnails.remove(key)
            return
        }
        thumbnails[key] = await image.byPreparingThumbnail(ofSize: CGSize(width: side, height: side)) ?? image
    }

    func thumbnail(_ path: String, in sessionId: String) -> UIImage? {
        thumbnails[Self.previewKey(path, sessionId)]
    }

    private static func previewKey(_ path: String, _ sessionId: String) -> String { "\(sessionId)\u{0}\(path)" }
    private static let previewsKept = 12

    /// A space's own picture, asked of the Mac once.
    func loadSpacePicture(_ spaceId: String) async {
        guard spacePictures[spaceId] == nil, !askedPictures.contains(spaceId), let api, isConnected else { return }
        askedPictures.insert(spaceId)
        do {
            let picture = try await api.spaceIcon(id: spaceId)
            if let image = UIImage(data: picture.data) { spacePictures[spaceId] = image }
        } catch {
            askedPictures.remove(spaceId)
        }
    }

    // MARK: - What waits to be sent

    func deliver(_ sessionId: String) async {
        guard let api, isConnected else { return }
        let outcome = await courier.deliver(sessionId, via: api)
        saveOutbox()
        if outcome == .unconfirmed, isConnected { scheduleRetry(sessionId) }
    }

    private func scheduleRetry(_ sessionId: String) {
        retryTasks[sessionId]?.cancel()
        retryTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !Task.isCancelled else { return }
            self.retryTasks[sessionId] = nil
            await self.deliverAnywhere(sessionId)
        }
    }

    /// Items of sessions that are not on screen go too: each such session is opened for the moment
    /// it takes to look for them and send them.
    private func deliverOutsideOpenSessions() async {
        let sessions = Set(store.outbox.items.filter(\.isPending).map(\.sessionId)).subtracting(visibleSessions)
        for session in sessions.sorted() { await deliverAnywhere(session) }
    }

    private func deliverAnywhere(_ sessionId: String) async {
        if visibleSessions.contains(sessionId) {
            await deliver(sessionId)
            return
        }
        guard let api, isConnected, store.outbox.items(for: sessionId).contains(where: \.isPending) else { return }
        store.beginOpening(sessionId)
        do {
            store.finishOpening(try await api.openSession(id: sessionId, limit: 100))
            await deliver(sessionId)
        } catch {
            store.cancelOpening(sessionId)
            report(error)
        }
        guard !visibleSessions.contains(sessionId) else { return }
        store.closeSession(sessionId)
        saveOutbox()
        try? await api.closeSession(id: sessionId)
    }

    private func forgetFetched() {
        everConnected = false
        // A draft's files were for that Mac's sessions.
        store.files.remove(draftAttachments.values.joined())
        draftAttachments = [:]
        work.forget()
        sessionOptions = [:]
        optionsUnanswered = []
        configuring = [:]
        for change in rowChanges.values { change.cancel() }
        rowChanges = [:]
        rowEdits = RowEdits()
        renaming = nil
        agentList = nil
        queueCalls = [:]
        spacePictures = [:]
        thumbnails = [:]
        previews = [:]
        previewOrder = []
        askedThumbnails = []
        turnChanges = [:]
        workingSince = [:]
        sessionScreens = [:]
        rowBirths = [:]
        askedPictures = []
        askedChanges = []
    }

    // MARK: - The cache

    private func saveOutbox() {
        guard let cache else { return }
        let items = store.outbox.items
        disk.async { try? cache.saveOutbox(items) }
    }

    private func saveTranscript(_ sessionId: String) {
        guard let cache, let transcript = store.transcripts[sessionId] else { return }
        let snapshot = TranscriptSnapshot(transcript)
        let savedAt = transcript.savedAt ?? Date()
        disk.async { try? cache.saveTranscript(snapshot, id: sessionId, at: savedAt) }
    }

    /// Streaming rows arrive ten times a second; the cache is written once they pause.
    private func saveTranscriptSoon(_ sessionId: String) {
        guard saveTasks[sessionId] == nil else { return }
        saveTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            self.saveTasks[sessionId] = nil
            self.saveTranscript(sessionId)
        }
    }

    private func saveEverything() {
        for session in visibleSessions { saveTranscript(session) }
        saveOutbox()
    }

    // MARK: - Notifications

    func registerForPushes() {
        UIApplication.shared.registerForRemoteNotifications()
        // Unattended runs must not leave a permission alert over the screen.
        guard !LaunchOptions.unattended else { return }
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshNotificationStatus()
        }
    }

    func refreshNotificationStatus() async {
        notificationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func didRegisterForPushes(deviceToken: Data) {
        let registration = PushRegistration(deviceToken: deviceToken, environment: DeviceInfo.pushEnvironment)
        pushRegistration = registration
        if let connection { Task { await connection.setPushRegistration(registration) } }
    }

    /// A tapped notification: its session, once the app knows its Mac.
    func show(session: String?) {
        guard let session else { return }
        guard launched, store.pairedMac != nil else {
            pendingSession = session
            return
        }
        settingsShown = false
        path = [.session(session)]
    }

    // MARK: - Words

    func show(toast text: String, undo: (@MainActor () -> Void)? = nil) {
        toast = Toast(text: text, undo: undo)
    }

    private func report(_ error: any Error) {
        show(toast: Self.describe(error))
    }

    static func describe(_ error: any Error) -> String {
        switch error {
        case let error as PairingLink.ParseError:
            switch error {
            case .expired: return "This pairing link has expired. Make a new one on your Mac."
            case .unknownVersion: return "This pairing link is from a newer Realm. Update Realm on this iPhone."
            case .malformed, .notAPairingLink: return "That is not a Realm pairing link."
            }
        case let error as PairingError:
            switch error {
            case .linkExpired: return "This pairing link has expired. Make a new one on your Mac."
            case .windowClosed: return "Your Mac is no longer pairing. Make a new link on your Mac."
            case .notAnswered: return "Your Mac did not accept this link. It may be from an earlier try: make a new one on your Mac."
            case .wrongMac: return "The answer did not come from the Mac in the link. Make a new one on your Mac."
            case .declined: return "Pairing was declined on your Mac."
            case .expired: return "Nobody confirmed on your Mac in time. Make a new link and try again."
            case .unexpectedAnswer(let detail): return "Pairing failed: \(detail)."
            case .connectionLost: return "The connection to the relay dropped while pairing. Try again."
            case .timedOut: return "Pairing took too long. Make a new link and try again."
            }
        case let error as ChannelError:
            switch error {
            case .notConnected: return "Not connected to your Mac."
            case .timedOut: return "Your Mac did not answer in time."
            case .connectionLost: return "The connection dropped before your Mac answered."
            case .macOffline: return "Your Mac is asleep."
            case .badResponse: return "Your Mac sent an answer this app cannot read. Update Realm on both."
            case .rpc(let error): return error.message
            }
        default:
            return error.localizedDescription
        }
    }
}

/// The id of a background task, filled in after the call that hands it out.
private final class BackgroundTask: @unchecked Sendable {
    var id: UIBackgroundTaskIdentifier = .invalid
}

/// The notification categories, one per kind of push the Mac seals (PROTOCOL.md §4.3). Answering from
/// a notification is Phase 3; for now each says, with previews hidden, what kind of moment it is.
enum NotificationKinds {
    static let placeholders: [String: String] = [
        "permission": "A session on your Mac is waiting on you",
        "question": "A session on your Mac has a question for you",
        "finished": "A session on your Mac finished",
        "failed": "A session on your Mac failed",
        "blocked": "A run on your Mac is blocked",
        "test": "A test from your Mac",
    ]

    static var categories: Set<UNNotificationCategory> {
        Set(placeholders.map { kind, placeholder in
            UNNotificationCategory(identifier: kind, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: placeholder,
                                   options: [])
        })
    }
}

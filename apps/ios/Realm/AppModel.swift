import Observation
import RealmKit
import SwiftUI
import UIKit
import UserNotifications
import os

enum Route: Hashable {
    case session(String)
    case settings
    case diagnostics
    case licences
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

/// Something that happened, said once and then gone.
struct Toast: Equatable, Identifiable {
    let id = UUID()
    let text: String
}

/// Everything the screens act through: pairing, the connection to the Mac, the cache, what waits to
/// be sent, notifications and where the person is.
@MainActor
@Observable
final class AppModel {
    let store: RealmStore
    let diagnostics = Diagnostics()
    var path: [Route] = []
    var pairing: PairingStatus = .idle
    var toast: Toast?
    /// A pairing link for a different Mac, waiting for the person to say it replaces this one.
    var replacingPairLink: String?
    /// What is typed in each session's composer and not sent yet: leaving a session keeps it.
    var composerDrafts: [String: String] = [:]
    /// The person asked to pair again over the Mac this phone shows (after the Mac removed it).
    var pairingRequested = false
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
    /// Sessions on screen: their rows are live and kept.
    @ObservationIgnored private var visibleSessions: Set<String> = []
    @ObservationIgnored private var saveTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var retryTasks: [String: Task<Void, Never>] = [:]

    init() {
        let store = RealmStore()
        self.store = store
        courier = Courier(store: store)
        courier.onAccepted = { item in
            // An answer confirms when the Mac takes it, never when the button is pressed.
            if case .answer = item.payload { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        }
    }

    var api: MobileAPI? { connection.map(MobileAPI.init) }
    var isConnected: Bool { store.connection.isConnected }
    var linkStatus: LinkStatus { store.linkStatus() }

    /// The Mac and its state, for the line under a title: "MacBook Pro · Asleep since 10:42".
    var macLine: String {
        [store.pairedMac?.macName, linkStatus.words].compactMap { $0 }.joined(separator: " · ")
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
                try? cache?.removeAll()
            }
            store.forgetEverything()
            adopt(mac)
            path = []
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
        try? cache?.removeAll()
        cache = nil
        store.forgetEverything()
        store.pairedMac = nil
        store.connection = .idle
        path = []
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
        print("[realm] connection: \(state)")
        if wasConnected && !state.isConnected { store.markStale() }
        guard case .connected(let mac) = state else { return }
        store.latency.handshake = mac.handshake
        store.latency.connect = mac.connect
        if var paired = store.pairedMac, paired.macName != mac.name {
            paired.macName = mac.name
            store.pairedMac = paired
            try? vault.save(paired)
        }
        channelGeneration += 1
        Task {
            await refreshHome()
            await deliverOutsideOpenSessions()
        }
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
        store.apply(event)
        if store.outbox != outbox { saveOutbox() }
        switch event {
        case .homeChanged:
            Task { await refreshHome() }
        case .sessionRows(let update) where visibleSessions.contains(update.id):
            saveTranscriptSoon(update.id)
        default:
            break
        }
    }

    // MARK: - Home

    func refreshHome() async {
        guard let api, isConnected else { return }
        do {
            let home = try await api.home()
            store.showHome(home)
            if let cache { Task.detached { try? cache.saveHome(home) } }
            // The badge says what Needs you says: the same moments the Mac's pushes are for.
            try? await UNUserNotificationCenter.current().setBadgeCount(home.needsYou.count)
        } catch {
            report(error)
        }
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

    /// A message, in line behind anything already waiting. It shows as Sending… until the Mac has it.
    func send(_ text: String, to sessionId: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.enqueueMessage(text, in: sessionId)
        saveOutbox()
        Task { await deliver(sessionId) }
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

    // MARK: - The cache

    private func saveOutbox() {
        guard let cache else { return }
        let items = store.outbox.items
        Task.detached { try? cache.saveOutbox(items) }
    }

    private func saveTranscript(_ sessionId: String) {
        guard let cache, let transcript = store.transcripts[sessionId] else { return }
        let snapshot = TranscriptSnapshot(transcript)
        let savedAt = transcript.savedAt ?? Date()
        Task.detached { try? cache.saveTranscript(snapshot, id: sessionId, at: savedAt) }
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
        path = [.session(session)]
    }

    // MARK: - Words

    func show(toast text: String) {
        toast = Toast(text: text)
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

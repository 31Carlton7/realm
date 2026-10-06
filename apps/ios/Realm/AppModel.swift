import Observation
import RealmKit
import SwiftUI
import UIKit
import UserNotifications
import os

enum Route: Hashable {
    case session(String)
    case diagnostics
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

/// Everything the screens act through: pairing, the connection to the Mac, and the calls.
@MainActor
@Observable
final class AppModel {
    let store = RealmStore()
    let diagnostics = Diagnostics()
    var path: [Route] = []
    var pairing: PairingStatus = .idle
    /// The last call that failed, said plainly; cleared by the next one that works.
    var problem: String?
    /// Goes up with every new channel. Open sessions open again, since a subscription does not
    /// outlive the channel it was made on.
    private(set) var channelGeneration = 0

    @ObservationIgnored let log = Logger(subsystem: "co.charmtechnologies.realm.ios", category: "app")
    @ObservationIgnored private let vault = Vault(store: KeychainStore())
    @ObservationIgnored private var identity: DeviceIdentity?
    @ObservationIgnored private(set) var connection: MobileConnection?
    @ObservationIgnored private var listeners: [Task<Void, Never>] = []
    @ObservationIgnored private var pushRegistration: PushRegistration?
    @ObservationIgnored private var launched = false
    @ObservationIgnored private var autoDiagnosticsStarted = false
    @ObservationIgnored private var launchSessionOpened = false

    var api: MobileAPI? { connection.map(MobileAPI.init) }
    var isConnected: Bool { store.connection.isConnected }

    // MARK: - Launch and pairing

    func launch() async {
        guard !launched else { return }
        launched = true
        do {
            identity = try vault.loadOrCreateIdentity()
        } catch {
            pairing = .failed("This iPhone's keys could not be read from the keychain. \(error.localizedDescription)")
            return
        }
        store.pairedMac = (try? vault.pairedMacs())?.last
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
            disconnect()
            store.home = nil
            store.pairedMac = mac
            pairing = .idle
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
        if let connection { Task { await connection.stop() } }
        connection = nil
        store.connection = .stopped
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            if store.pairedMac != nil, connection == nil, launched { connect() }
        case .background:
            // iOS suspends a backgrounded app; closing first lets the relay and the Mac see it go.
            if !LaunchOptions.autoDiagnostics { disconnect() }
        default:
            break
        }
    }

    private func connectionChanged(_ state: ConnectionState) {
        store.connection = state
        print("[realm] connection: \(state)")
        guard case .connected(let mac) = state else { return }
        store.latency.handshake = mac.handshake
        store.latency.connect = mac.connect
        if var paired = store.pairedMac, paired.macName != mac.name {
            paired.macName = mac.name
            store.pairedMac = paired
            try? vault.save(paired)
        }
        channelGeneration += 1
        Task { await refreshHome() }
        if let session = LaunchOptions.openSession, !launchSessionOpened {
            launchSessionOpened = true
            path = [.session(session)]
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
        store.apply(event)
        if case .homeChanged = event { Task { await refreshHome() } }
    }

    // MARK: - Calls

    func refreshHome() async {
        guard let api, isConnected else { return }
        do {
            store.home = try await api.home()
            problem = nil
        } catch {
            problem = Self.describe(error)
        }
    }

    /// What Diagnostics opens when it is not told which: an idle session, since a message sent to one
    /// that is waiting on a permission is held in the Mac's queue and never echoes in time.
    var diagnosticsSessionId: String? {
        let sessions = (store.home?.spaces ?? []).flatMap(\.sessions)
        return (sessions.first { $0.status == .idle } ?? sessions.first { $0.status != .waiting } ?? sessions.first)?.id
    }

    func open(_ sessionId: String) async {
        guard let api, isConnected else { return }
        store.beginOpening(sessionId)
        do {
            store.finishOpening(try await api.openSession(id: sessionId))
            problem = nil
        } catch {
            store.cancelOpening(sessionId)
            problem = Self.describe(error)
        }
    }

    func close(_ sessionId: String) async {
        store.closeSession(sessionId)
        guard let api, isConnected else { return }
        try? await api.closeSession(id: sessionId)
    }

    /// True once the Mac has the message.
    func send(_ text: String, to sessionId: String) async -> Bool {
        guard let api else { return false }
        do {
            try await api.send(id: sessionId, text: text)
            problem = nil
            return true
        } catch {
            problem = Self.describe(error)
            return false
        }
    }

    func stop(_ sessionId: String) async {
        guard let api else { return }
        do {
            try await api.stop(id: sessionId)
        } catch {
            problem = Self.describe(error)
        }
    }

    /// True once the Mac has accepted the answer.
    func answer(_ sessionId: String, requestId: String, decision: Decision, answers: [String: String]? = nil) async -> Bool {
        guard let api else { return false }
        do {
            try await api.answer(id: sessionId, requestId: requestId, decision: decision, answers: answers)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            return true
        } catch {
            problem = Self.describe(error)
            return false
        }
    }

    // MARK: - Pushes

    func registerForPushes() {
        UIApplication.shared.registerForRemoteNotifications()
        // Unattended runs must not leave a permission alert over the screen.
        guard !LaunchOptions.autoDiagnostics else { return }
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    func didRegisterForPushes(deviceToken: Data) {
        let registration = PushRegistration(deviceToken: deviceToken, environment: DeviceInfo.pushEnvironment)
        pushRegistration = registration
        if let connection { Task { await connection.setPushRegistration(registration) } }
    }

    func show(session: String?) {
        guard let session, store.pairedMac != nil else { return }
        path = [.session(session)]
    }

    // MARK: - Words

    var macStatus: (text: String, symbol: String) {
        switch store.connection {
        case .connected: ("Online", "checkmark.circle")
        case .macOffline(let lastSeen):
            if let lastSeen {
                ("Offline since \(Date(timeIntervalSince1970: lastSeen / 1000).formatted(date: .omitted, time: .shortened))", "moon.zzz")
            } else {
                ("Offline", "moon.zzz")
            }
        case .connecting, .handshaking: ("Connecting", "arrow.triangle.2.circlepath")
        case .retrying: ("Can't reach the relay", "exclamationmark.triangle")
        case .refused: ("Not allowed", "xmark.octagon")
        case .idle, .stopped: ("Not connected", "pause.circle")
        }
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
            case .notAnswered: return "Your Mac did not accept this link. Make a new one on your Mac."
            case .wrongMac: return "The answer did not come from the Mac in the link."
            case .declined: return "Pairing was declined on your Mac."
            case .expired: return "Nobody confirmed on your Mac in time."
            case .unexpectedAnswer(let detail): return "Pairing failed: \(detail)."
            case .connectionLost: return "The connection to the relay dropped while pairing."
            case .timedOut: return "Pairing took too long."
            }
        case let error as ChannelError:
            switch error {
            case .notConnected: return "Not connected to your Mac."
            case .timedOut: return "Your Mac did not answer in time."
            case .connectionLost: return "The connection dropped before your Mac answered."
            case .macOffline: return "Your Mac is offline."
            case .badResponse: return "Your Mac sent an answer this app cannot read. Update Realm on both."
            case .rpc(let error): return error.message
            }
        default:
            return error.localizedDescription
        }
    }
}

import CryptoKit
import Foundation

/// What the phone says about itself in IK message 1: `{"v":1,"app":"<app version>","os":"<OS version>"}`.
public struct ClientInfo: Codable, Sendable, Equatable {
    public var v = 1
    public let app: String
    public let os: String

    public init(app: String, os: String) {
        self.app = app
        self.os = os
    }
}

/// IK message 2's payload: `{"v":1,"mac":"<Mac name>","server":"<Realm version>","relay":"<relay base>"}`.
struct MacHello: Decodable {
    let v: Int
    let mac: String
    let server: String?
    /// The Mac's own relay (§3.3). A Mac before it, or one whose relay has not answered it, names none.
    let relay: String?
}

public struct ConnectedMac: Sendable, Equatable {
    public let name: String
    public let server: String
    /// The relay the Mac says it is on (§3.3), when it names one that is a relay base. A pairing that
    /// dials another moves to it.
    public let relay: URL?
    /// IK message 1 sent → message 2 read: the Noise round trip through the relay and the Mac.
    public let handshake: Duration
    /// Socket created → channel ready: what a person waits for.
    public let connect: Duration

    init(name: String, server: String, relay: URL? = nil, handshake: Duration, connect: Duration) {
        self.name = name
        self.server = server
        self.relay = relay
        self.handshake = handshake
        self.connect = connect
    }
}

public enum ConnectionState: Sendable, Equatable {
    case idle
    case connecting
    case handshaking
    case connected(ConnectedMac)
    /// The relay is reachable and the Mac is not.
    case macOffline(lastSeen: Millis?)
    case retrying(in: Duration)
    /// The relay or the Mac refused this phone; trying again would not help.
    case refused(code: Int, reason: String)
    case stopped

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// `{"t":"apns","token":"<hex device token>","env":"sandbox"|"production"}` (§3.2).
public struct PushRegistration: Encodable, Sendable, Equatable {
    public var t = "apns"
    public let token: String
    public let env: String

    public init(deviceToken: Data, environment: String) {
        token = Hex.encode(deviceToken)
        env = environment
    }
}

public enum ChannelError: Error, Equatable, Sendable {
    case notConnected
    case timedOut
    case connectionLost
    case macOffline
    case badResponse(String)
    case rpc(RPCError)
}

/// A paired phone's connection to its Mac (PROTOCOL.md §4.2, §6): the relay socket, IK, frames, calls
/// matched to responses by id, and events. It reconnects with backoff until stopped or refused.
public actor MobileConnection {
    public nonisolated let mac: PairedMac
    public nonisolated let events: AsyncStream<MobileEvent>
    public nonisolated let states: AsyncStream<ConnectionState>
    private nonisolated let eventSink: AsyncStream<MobileEvent>.Continuation
    private nonisolated let stateSink: AsyncStream<ConnectionState>.Continuation

    public private(set) var state: ConnectionState = .idle

    private let identity: DeviceIdentity
    private let client: ClientInfo
    private let factory: any WebSocketFactory
    private let backoff: Backoff
    private let handshakeTimeout: Duration
    private let requestTimeout: Duration
    private let heartbeat: Duration

    private struct PendingHandshake {
        var state: HandshakeState
        let sentAt: ContinuousClock.Instant
        let generation: Int
    }

    private struct OpenChannel {
        var send: CipherState
        var receive: CipherState
        var assembler = Frames.Assembler()
    }

    private struct PendingCall {
        let continuation: CheckedContinuation<Data, Error>
        let timer: Task<Void, Never>
    }

    private var supervisor: Task<Void, Never>?
    private var stopped = false
    private var socket: RelaySocket?
    private var socketCreatedAt = ContinuousClock.now
    private var handshake: PendingHandshake?
    private var channel: OpenChannel?
    private var generation = 0
    private var nextRequestId = 1
    private var pending: [Int: PendingCall] = [:]
    private var waiters: [UUID: CheckedContinuation<ConnectedMac, Error>] = [:]
    private var pushRegistration: PushRegistration?
    private var relayReady = false

    public init(
        mac: PairedMac,
        identity: DeviceIdentity,
        client: ClientInfo,
        factory: any WebSocketFactory = URLSessionWebSocketFactory(),
        backoff: Backoff = Backoff(),
        handshakeTimeout: Duration = .seconds(10),
        requestTimeout: Duration = .seconds(15),
        heartbeat: Duration = RelaySocket.heartbeatInterval
    ) {
        self.mac = mac
        self.identity = identity
        self.client = client
        self.factory = factory
        self.backoff = backoff
        self.handshakeTimeout = handshakeTimeout
        self.requestTimeout = requestTimeout
        self.heartbeat = heartbeat
        (events, eventSink) = AsyncStream.makeStream(of: MobileEvent.self, bufferingPolicy: .unbounded)
        (states, stateSink) = AsyncStream.makeStream(of: ConnectionState.self, bufferingPolicy: .unbounded)
    }

    deinit {
        eventSink.finish()
        stateSink.finish()
    }

    public func start() {
        guard supervisor == nil else { return }
        stopped = false
        supervisor = Task { await self.supervise() }
    }

    public func stop() async {
        stopped = true
        supervisor?.cancel()
        supervisor = nil
        if let socket { await socket.close(code: 1000, reason: nil) }
        socket = nil
        dropChannel(failing: .connectionLost)
        failWaiters(.connectionLost)
        setState(.stopped)
    }

    /// Waits until the channel is open.
    public func connected(timeout: Duration) async throws -> ConnectedMac {
        if case .connected(let info) = state { return info }
        if case .refused = state { throw ChannelError.notConnected }
        let id = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            waiters[id] = continuation
            Task {
                try? await Task.sleep(for: timeout)
                self.expireWaiter(id)
            }
        }
    }

    /// Tells the relay where to send this phone's pushes, now and after every reconnect.
    public func setPushRegistration(_ registration: PushRegistration) {
        pushRegistration = registration
        if relayReady { socket?.sendControl(registration) }
    }

    /// Calls a `mobile.v1` method and decodes its result.
    public func call<Params: Encodable & Sendable, Result: Decodable & Sendable>(
        _ method: String, params: Params, as type: Result.Type = Result.self, timeout: Duration? = nil
    ) async throws -> Result {
        let response = try await send(method: method, params: params, timeout: timeout ?? requestTimeout)
        return try Envelope.result(Result.self, from: response)
    }

    public func call<Result: Decodable & Sendable>(_ method: String, as type: Result.Type = Result.self) async throws -> Result {
        try await call(method, params: EmptyParams(), as: type)
    }

    // MARK: - Calls

    private func send(method: String, params: some Encodable & Sendable, timeout: Duration) async throws -> Data {
        guard var channel, let socket else { throw ChannelError.notConnected }
        let id = nextRequestId
        nextRequestId += 1
        let frames = try Frames.seal(Envelope.request(id: id, method: method, params: params), with: &channel.send)
        self.channel = channel
        return try await withCheckedThrowingContinuation { continuation in
            let timer = Task {
                try? await Task.sleep(for: timeout)
                self.expireCall(id)
            }
            pending[id] = PendingCall(continuation: continuation, timer: timer)
            for frame in frames { socket.send(frame) }
        }
    }

    private func expireCall(_ id: Int) {
        guard let call = pending.removeValue(forKey: id) else { return }
        call.continuation.resume(throwing: ChannelError.timedOut)
    }

    private func expireWaiter(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: ChannelError.timedOut)
    }

    private func failWaiters(_ error: ChannelError) {
        let current = waiters
        waiters.removeAll()
        for waiter in current.values { waiter.resume(throwing: error) }
    }

    // MARK: - The connection

    private func supervise() async {
        var attempt = 0
        while !stopped && !Task.isCancelled {
            let socket = RelaySocket(
                relay: mac.relay, macId: mac.macId,
                role: .phone(phoneId: mac.phoneId, identity: identity),
                factory: factory, heartbeat: heartbeat
            )
            self.socket = socket
            socketCreatedAt = .now
            relayReady = false
            setState(.connecting)
            await socket.start()
            var closeInfo: WebSocketClose?
            var reachedMac = false
            for await event in socket.events {
                switch event {
                case .authSent:
                    // Pipelined: message 1 goes right behind `auth`, without waiting for `ready`.
                    beginHandshake()
                case .ready(let presence):
                    relayReady = true
                    if let pushRegistration { socket.sendControl(pushRegistration) }
                    if let presence, !presence.online { macWentOffline(lastSeen: presence.lastSeen) }
                case .mac(let presence):
                    // The Mac's channel state did not survive its going away, so every `online` starts over.
                    if presence.online { beginHandshake() } else { macWentOffline(lastSeen: presence.lastSeen) }
                case .data(let bytes):
                    if receive(bytes) { reachedMac = true }
                case .control:
                    break
                case .closed(let info):
                    closeInfo = info
                }
            }
            if self.socket === socket { self.socket = nil }
            dropChannel(failing: .connectionLost)
            if stopped || Task.isCancelled { return }
            if let info = closeInfo, let reason = Self.refusal(info.code) {
                setState(.refused(code: info.code, reason: reason))
                failWaiters(.notConnected)
                supervisor = nil
                return
            }
            attempt = reachedMac ? 0 : attempt + 1
            let delay = backoff.delay(attempt: attempt)
            setState(.retrying(in: delay))
            do { try await Task.sleep(for: delay) } catch { return }
        }
    }

    /// Close codes after which reconnecting cannot help (§3.1).
    public static func refusal(_ code: Int) -> String? {
        switch code {
        case 4401: "The relay could not verify this iPhone."
        case 4403: "Your Mac does not list this iPhone. Pair it again."
        case 4409: "This iPhone connected to your Mac again from somewhere else."
        case 4410: "Your Mac removed this iPhone."
        default: nil
        }
    }

    private func beginHandshake() {
        guard let socket else { return }
        dropChannel(failing: .connectionLost)
        generation += 1
        do {
            var state = try HandshakeState(
                pattern: .IK, initiator: true,
                prologue: Prologue.ik(macId: mac.macId, phoneId: mac.phoneId),
                localStatic: identity.dh, remoteStatic: mac.macKey
            )
            let message = try state.writeMessage(try JSONEncoder.realm.encode(client))
            handshake = PendingHandshake(state: state, sentAt: .now, generation: generation)
            socket.send(message)
            setState(.handshaking)
            let generation = generation
            Task {
                try? await Task.sleep(for: handshakeTimeout)
                await self.handshakeTimedOut(generation)
            }
        } catch {
            Task { await socket.close(code: 4000, reason: "Could not start the handshake") }
        }
    }

    private func handshakeTimedOut(_ generation: Int) async {
        guard let handshake, handshake.generation == generation, let socket else { return }
        self.handshake = nil
        await socket.close(code: 4000, reason: "The Mac did not answer the handshake")
    }

    private func macWentOffline(lastSeen: Millis?) {
        dropChannel(failing: .macOffline)
        setState(.macOffline(lastSeen: lastSeen))
    }

    /// Takes one binary message: IK message 2 while handshaking, a transport frame after.
    /// Returns true when it completed the handshake.
    private func receive(_ bytes: Data) -> Bool {
        if var inFlight = handshake {
            handshake = nil
            do {
                let payload = try inFlight.state.readMessage(bytes)
                let ciphers = try inFlight.state.split()
                let hello = try JSONDecoder().decode(MacHello.self, from: payload)
                channel = OpenChannel(send: ciphers.initiatorToResponder, receive: ciphers.responderToInitiator)
                let now = ContinuousClock.now
                let info = ConnectedMac(name: hello.mac, server: hello.server ?? "", relay: hello.relay.flatMap(PairingLink.relayBase),
                                        handshake: now - inFlight.sentAt, connect: now - socketCreatedAt)
                setState(.connected(info))
                let current = waiters
                waiters.removeAll()
                for waiter in current.values { waiter.resume(returning: info) }
                return true
            } catch {
                // Not the Mac this phone paired with, or a broken message: start over on a new socket.
                closeSocket(reason: "The Mac's answer did not open")
                return false
            }
        }
        guard var channel else { return false }
        do {
            let message = try channel.assembler.open(bytes, with: &channel.receive)
            self.channel = channel
            if let message { dispatch(message) }
        } catch {
            self.channel = nil
            closeSocket(reason: "A frame did not open")
        }
        return false
    }

    private func dispatch(_ message: Data) {
        switch Envelope.classify(message) {
        case .response(let id):
            guard let call = pending.removeValue(forKey: id) else { return }
            call.timer.cancel()
            call.continuation.resume(returning: message)
        case .event(let event):
            eventSink.yield(event)
        case .unrecognized:
            break
        }
    }

    private func dropChannel(failing error: ChannelError) {
        channel = nil
        handshake = nil
        let calls = pending
        pending.removeAll()
        for call in calls.values {
            call.timer.cancel()
            call.continuation.resume(throwing: error)
        }
    }

    private func closeSocket(reason: String) {
        guard let socket else { return }
        Task { await socket.close(code: 4000, reason: reason) }
    }

    private func setState(_ newState: ConnectionState) {
        guard !stopped || newState == .stopped else { return }
        state = newState
        stateSink.yield(newState)
    }
}

/// Typed `mobile.v1` calls (PROTOCOL.md §8).
public struct MobileAPI: Sendable {
    public let connection: MobileConnection

    public init(connection: MobileConnection) {
        self.connection = connection
    }

    public func ping() async throws -> Pong {
        try await connection.call("ping", as: Pong.self)
    }

    public func home() async throws -> Home {
        try await connection.call("home.get", as: Home.self)
    }

    /// Home, with `recent` gathered for one profile; nil gathers it for every profile.
    public func home(profileId: String?) async throws -> Home {
        struct Params: Encodable, Sendable { let profileId: String? }
        return try await connection.call("home.get", params: Params(profileId: profileId), as: Home.self)
    }

    /// One page of a space's listed sessions, most recently active first.
    public func spaceSessions(id: String, offset: Int = 0, limit: Int = 50) async throws -> SpaceSessions {
        struct Params: Encodable, Sendable { let id: String; let offset: Int; let limit: Int }
        return try await connection.call("space.sessions", params: Params(id: id, offset: offset, limit: limit), as: SpaceSessions.self)
    }

    /// The session's model, reasoning, mode and permissions, and what each could be changed to. A Mac
    /// before Plan 29 answers `METHOD_NOT_FOUND`, and takes no files with a message either.
    public func options(id: String) async throws -> SessionOptions {
        try await connection.call("session.options", params: SessionID(id: id), as: SessionOptions.self)
    }

    /// Changes what the composer's chips show, and answers with the options as they are now.
    public func configure(id: String, _ changes: SessionChanges) async throws -> SessionOptions {
        struct Params: Encodable, Sendable {
            let id: String
            let changes: SessionChanges
            func encode(to encoder: Encoder) throws {
                try changes.encode(to: encoder)
                var c = encoder.container(keyedBy: Key.self)
                try c.encode(id, forKey: .id)
            }
            enum Key: String, CodingKey { case id }
        }
        return try await connection.call("session.configure", params: Params(id: id, changes: changes), as: SessionOptions.self)
    }

    /// Where the session can be moved to on its Mac, and what would go with it. A Mac before moves
    /// answers `METHOD_NOT_FOUND`.
    public func moveOptions(id: String) async throws -> MoveOptions {
        try await connection.call("session.moveOptions", params: SessionID(id: id), as: MoveOptions.self)
    }

    /// Moves the session, answering once the move is done — or queued, for after the turn — with its row.
    /// A move makes a worktree and starts the agent there before it answers, so it is given a few minutes.
    public func move(id: String, to target: MoveTarget, when: MoveWhen) async throws -> SessionRow {
        struct Params: Encodable, Sendable { let id: String; let to: MoveTarget; let when: MoveWhen }
        return try await connection.call("session.move", params: Params(id: id, to: target, when: when), as: MovedSession.self,
                                         timeout: .seconds(180)).session
    }

    /// Drops a move queued behind the turn, or stops one under way; false when there was nothing to stop.
    public func cancelMove(id: String) async throws -> Bool {
        try await connection.call("session.cancelMove", params: SessionID(id: id), as: CancelledMove.self).cancelled
    }

    /// Deletes the session, as the desktop's Delete does: its agent stops, and its transcript and row go.
    public func deleteSession(id: String) async throws {
        _ = try await connection.call("session.delete", params: SessionID(id: id), as: Acknowledged.self)
    }

    /// A new session forked from this one as it is now, onto `agent` where it names another: a new
    /// worktree and the conversation carried in as text, so it is given a few minutes.
    public func forkSession(id: String, agent: String? = nil) async throws -> SessionRow {
        struct Params: Encodable, Sendable { let id: String; let agent: String? }
        return try await connection.call("session.fork", params: Params(id: id, agent: agent), as: MovedSession.self,
                                         timeout: .seconds(180)).session
    }

    /// Moves the session to another space, as the sidebar's Move to space… does.
    public func moveToSpace(id: String, spaceId: String) async throws -> SessionRow {
        struct Params: Encodable, Sendable { let id: String; let spaceId: String }
        return try await connection.call("session.moveToSpace", params: Params(id: id, spaceId: spaceId), as: MovedSession.self).session
    }

    /// Moves the session onto another agent, on its own default model. The Mac writes a summary of the
    /// conversation for it first, so it is given a few minutes.
    public func switchAgent(id: String, agent: String) async throws -> SessionRow {
        struct Params: Encodable, Sendable { let id: String; let agent: String }
        return try await connection.call("session.switchAgent", params: Params(id: id, agent: agent), as: MovedSession.self,
                                         timeout: .seconds(180)).session
    }

    /// The logins the session's agent can run on, and the one it runs on now.
    public func accounts(id: String) async throws -> SessionAccounts {
        try await connection.call("session.accounts", params: SessionID(id: id), as: SessionAccounts.self)
    }

    public func setAccount(id: String, accountId: String) async throws -> SessionRow {
        struct Params: Encodable, Sendable { let id: String; let accountId: String }
        return try await connection.call("session.setAccount", params: Params(id: id, accountId: accountId), as: MovedSession.self).session
    }

    /// The session's saved turns, by their prompts' `seq`s.
    public func saved(id: String) async throws -> [Int] {
        struct Answer: Decodable, Sendable { let seqs: [Int] }
        return try await connection.call("session.saved", params: SessionID(id: id), as: Answer.self).seqs
    }

    /// Saves or unsaves one turn by its prompt's row, and answers with the session's saved turns.
    public func setSaved(id: String, seq: Int, saved: Bool) async throws -> [Int] {
        struct Params: Encodable, Sendable { let id: String; let seq: Int; let saved: Bool }
        struct Answer: Decodable, Sendable { let seqs: [Int] }
        return try await connection.call("session.setSaved", params: Params(id: id, seq: seq, saved: saved), as: Answer.self).seqs
    }

    /// Every turn saved in a profile's sessions, the newest saved first.
    public func savedTurns(profileId: String) async throws -> SavedTurns {
        struct Params: Encodable, Sendable { let profileId: String }
        return try await connection.call("saved.list", params: Params(profileId: profileId), as: SavedTurns.self)
    }

    /// The agents a new session could be given, and the one the Mac starts with.
    public func agents() async throws -> AgentList {
        try await connection.call("agents.list", as: AgentList.self)
    }

    public func openSession(id: String, limit: Int? = nil) async throws -> OpenedSession {
        struct Params: Encodable, Sendable { let id: String; let limit: Int? }
        return try await connection.call("session.open", params: Params(id: id, limit: limit), as: OpenedSession.self)
    }

    public func closeSession(id: String) async throws {
        _ = try await connection.call("session.close", params: SessionID(id: id), as: Acknowledged.self)
    }

    /// `attachments` go only to a Mac that answers `session.options`: an older one would drop them.
    /// `mentionRefs` say what each `@[label]` in `text` names; they go only to a Mac that answers
    /// `session.composer`, since an older one refuses a field it does not know.
    public func send(id: String, text: String, delivery: Delivery? = nil, attachments: [AttachmentUpload] = [],
                     mentionRefs: [MentionRef] = [], timeout: Duration? = nil) async throws {
        struct Params: Encodable, Sendable {
            let id: String
            let text: String
            let delivery: Delivery?
            let attachments: [AttachmentUpload]
            let mentionRefs: [MentionRef]
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: Key.self)
                try c.encode(id, forKey: .id)
                try c.encode(text, forKey: .text)
                try c.encodeIfPresent(delivery, forKey: .delivery)
                // Left out when empty, so a message without files reads to an older Mac as it always did.
                if !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
                if !mentionRefs.isEmpty { try c.encode(mentionRefs, forKey: .mentionRefs) }
            }
            enum Key: String, CodingKey { case id, text, delivery, attachments, mentionRefs }
        }
        _ = try await connection.call("session.send",
                                      params: Params(id: id, text: text, delivery: delivery, attachments: attachments, mentionRefs: mentionRefs),
                                      as: Acknowledged.self, timeout: timeout)
    }

    /// The person's own commands and the skills the session's agent can be handed: what the composer's
    /// `/` and `@` list beside what the phone holds. A Mac from before them answers METHOD_NOT_FOUND.
    public func composer(id: String) async throws -> ComposerLists {
        try await connection.call("session.composer", params: SessionID(id: id), as: ComposerLists.self)
    }

    /// The files in the session's folder that best match `query`.
    public func mentionFiles(id: String, query: String) async throws -> [MentionFile] {
        struct Params: Encodable, Sendable { let id: String; let query: String }
        struct Answer: Decodable, Sendable { let files: [MentionFile] }
        return try await connection.call("session.mentionFiles", params: Params(id: id, query: query), as: Answer.self).files
    }

    /// One of the person's own commands filled in with `args`, for the composer to hold.
    public func expandCommand(id: String, name: String, args: String) async throws -> ExpandedCommand {
        struct Params: Encodable, Sendable { let id: String; let name: String; let args: String }
        return try await connection.call("session.expandCommand", params: Params(id: id, name: name, args: args), as: ExpandedCommand.self)
    }

    /// Starts a goal: the session works towards `objective` across turns.
    public func startGoal(id: String, objective: String) async throws {
        struct Params: Encodable, Sendable { let id: String; let objective: String }
        _ = try await connection.call("session.goal", params: Params(id: id, objective: objective), as: Acknowledged.self)
    }

    /// Pauses, resumes, marks done or drops the session's goal; the goal as it now stands, nil once dropped.
    public func controlGoal(id: String, action: GoalAction) async throws -> Goal? {
        struct Params: Encodable, Sendable { let id: String; let action: GoalAction }
        struct Answer: Decodable, Sendable { let goal: Goal? }
        return try await connection.call("session.goalControl", params: Params(id: id, action: action), as: Answer.self).goal
    }

    /// `answers` maps a question's text to the chosen label; several labels for a multi-select
    /// question are joined with ", ", as Phase 1's question card did.
    public func answer(id: String, requestId: String, decision: Decision, answers: [String: String]? = nil,
                       timeout: Duration? = nil) async throws {
        try await answer(id: id, requestId: requestId, decision: decision, values: answers?.mapValues(AnswerValue.one), timeout: timeout)
    }

    /// `values` maps a question's key to its answer, several picks as a list, as the desktop's card
    /// hands them back (`AnswerDraft.values`).
    public func answer(id: String, requestId: String, decision: Decision, values: [String: AnswerValue]?,
                       timeout: Duration? = nil) async throws {
        struct Params: Encodable, Sendable { let id: String; let requestId: String; let decision: Decision; let answers: [String: AnswerValue]? }
        _ = try await connection.call("session.answer",
                                      params: Params(id: id, requestId: requestId, decision: decision, answers: values),
                                      as: Acknowledged.self, timeout: timeout)
    }

    /// The files one of the session's turns changed, by the checkpoint in front of it.
    public func changes(id: String, checkpointId: String) async throws -> TurnChanges {
        struct Params: Encodable, Sendable { let id: String; let checkpointId: String }
        return try await connection.call("session.changes", params: Params(id: id, checkpointId: checkpointId), as: TurnChanges.self)
    }

    /// One page of a changed file's diff, from line `from`.
    public func diff(id: String, checkpointId: String, path: String, from: Int = 0) async throws -> DiffPage {
        struct Params: Encodable, Sendable { let id: String; let checkpointId: String; let path: String; let from: Int }
        return try await connection.call("session.diff", params: Params(id: id, checkpointId: checkpointId, path: path, from: from), as: DiffPage.self)
    }

    /// A preview of a file the session's turns made, by the path its row names.
    public func file(id: String, path: String) async throws -> FilePreview {
        struct Params: Encodable, Sendable { let id: String; let path: String }
        return try await connection.call("session.file", params: Params(id: id, path: path), as: FilePreview.self)
    }

    /// A piece of one of the files `file(id:path:)` previews, from byte `from`.
    public func fileData(id: String, path: String, from: Int) async throws -> FilePiece {
        struct Params: Encodable, Sendable { let id: String; let path: String; let from: Int }
        return try await connection.call("session.fileData", params: Params(id: id, path: path, from: from), as: FilePiece.self)
    }

    /// A space's own picture, for a space whose icon is one.
    /// The simulators and machines open in the session's space, live ones first.
    public func screens(id: String) async throws -> [SessionScreen] {
        struct Answer: Decodable, Sendable { let screens: [SessionScreen] }
        return try await connection.call("session.screens", params: SessionID(id: id), as: Answer.self).screens
    }

    /// One picture of a screen in the session's space, no larger than `maxSide` on its longer side.
    public func screen(id: String, screen: SessionScreen, maxSide: Int) async throws -> ScreenFrame {
        struct Params: Encodable, Sendable { let id: String; let screenId: String; let kind: SessionScreen.Kind; let maxSide: Int }
        return try await connection.call("session.screen", params: Params(id: id, screenId: screen.id, kind: screen.kind, maxSide: maxSide),
                                         as: ScreenFrame.self)
    }

    public func spaceIcon(id: String) async throws -> SpacePicture {
        try await connection.call("space.icon", params: SessionID(id: id), as: SpacePicture.self)
    }

    public func stop(id: String) async throws {
        _ = try await connection.call("session.stop", params: SessionID(id: id), as: Acknowledged.self)
    }

    /// Marks the session read up to `seq`, as opening it on the Mac does. The Mac never moves it back.
    public func seen(id: String, seq: Int) async throws {
        struct Params: Encodable, Sendable { let id: String; let seq: Int }
        _ = try await connection.call("session.seen", params: Params(id: id, seq: seq), as: Acknowledged.self)
    }

    public func createSession(spaceId: String, agent: String, text: String) async throws -> CreatedSession {
        struct Params: Encodable, Sendable { let spaceId: String; let agent: String; let text: String }
        return try await connection.call("session.create", params: Params(spaceId: spaceId, agent: agent, text: text),
                                         as: CreatedSession.self)
    }

    /// A new session with its first message; what `settings` leaves nil is the Mac's default.
    public func createSession(spaceId: String, agent: String, text: String, settings: SessionChanges,
                              attachments: [AttachmentUpload] = [], timeout: Duration? = nil) async throws -> CreatedSession {
        struct Params: Encodable, Sendable {
            let spaceId: String
            let agent: String
            let text: String
            let settings: SessionChanges
            let attachments: [AttachmentUpload]
            func encode(to encoder: Encoder) throws {
                try settings.encode(to: encoder)
                var c = encoder.container(keyedBy: Key.self)
                try c.encode(spaceId, forKey: .spaceId)
                try c.encode(agent, forKey: .agent)
                try c.encode(text, forKey: .text)
                if !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
            }
            enum Key: String, CodingKey { case spaceId, agent, text, attachments }
        }
        return try await connection.call("session.create",
                                         params: Params(spaceId: spaceId, agent: agent, text: text, settings: settings, attachments: attachments),
                                         as: CreatedSession.self, timeout: timeout)
    }

    /// Renames, pins or archives a session's row; nil fields stay as they are. Answers with its row,
    /// or nil once it is archived.
    public func updateSession(id: String, title: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) async throws -> SessionRow? {
        struct Params: Encodable, Sendable { let id: String; let title: String?; let pinned: Bool?; let archived: Bool? }
        struct Answer: Decodable, Sendable { let session: SessionRow? }
        return try await connection.call("session.update", params: Params(id: id, title: title, pinned: pinned, archived: archived),
                                         as: Answer.self).session
    }

    /// The messages waiting in the Mac's queue.
    public func queue(id: String) async throws -> [QueuedMessage] {
        struct Answer: Decodable, Sendable { let queued: [QueuedMessage] }
        return try await connection.call("session.queue", params: SessionID(id: id), as: Answer.self).queued
    }

    /// Sends one queued message now, ahead of the turn it was waiting for.
    public func sendQueuedNow(id: String, queuedId: String) async throws {
        _ = try await connection.call("session.sendQueuedNow", params: QueuedID(id: id, queuedId: queuedId), as: Acknowledged.self)
    }

    /// Takes a queued message out of the queue; it is not sent.
    public func removeQueued(id: String, queuedId: String) async throws {
        _ = try await connection.call("session.removeQueued", params: QueuedID(id: id, queuedId: queuedId), as: Acknowledged.self)
    }

    /// Holds a queued message while it is edited here, or lets it go.
    public func holdQueued(id: String, queuedId: String, held: Bool) async throws {
        struct Params: Encodable, Sendable { let id: String; let queuedId: String; let held: Bool }
        _ = try await connection.call("session.holdQueued", params: Params(id: id, queuedId: queuedId, held: held), as: Acknowledged.self)
    }

    /// Replaces a queued message's words, keeping its files, and lets it go.
    public func editQueued(id: String, queuedId: String, text: String) async throws {
        struct Params: Encodable, Sendable { let id: String; let queuedId: String; let text: String }
        _ = try await connection.call("session.editQueued", params: Params(id: id, queuedId: queuedId, text: text), as: Acknowledged.self)
    }

    /// The sub-agents a session started, newest first.
    public func subagents(id: String) async throws -> [Subagent] {
        struct Answer: Decodable, Sendable { let subagents: [Subagent] }
        return try await connection.call("session.subagents", params: SessionID(id: id), as: Answer.self).subagents
    }

    /// Every space's teammates, each space's Lead first. A Mac older than teammates answers
    /// `METHOD_NOT_FOUND`.
    public func teammates() async throws -> [Teammate] {
        struct Answer: Decodable, Sendable { let teammates: [Teammate] }
        return try await connection.call("teammates.list", as: Answer.self).teammates
    }

    /// Every space's teammates put away. A Mac from before archiving reached the phone names its listed
    /// ones instead, without `archived`: they are left out, so it has none.
    public func archivedTeammates() async throws -> [Teammate] {
        struct Params: Encodable, Sendable { let archived = true }
        struct Answer: Decodable, Sendable { let teammates: [Teammate] }
        return try await connection.call("teammates.list", params: Params(), as: Answer.self).teammates.filter { $0.archived == true }
    }

    /// A new teammate, made as the Mac's New teammate sheet makes one, with its chat.
    public func createTeammate(_ new: NewTeammate) async throws -> Teammate {
        struct Answer: Decodable, Sendable { let teammate: Teammate }
        return try await connection.call("teammate.create", params: new, as: Answer.self).teammate
    }

    /// Puts a teammate away, or brings it back.
    public func archiveTeammate(id: String, archived: Bool) async throws -> Teammate {
        struct Params: Encodable, Sendable { let id: String; let archived: Bool }
        struct Answer: Decodable, Sendable { let teammate: Teammate }
        return try await connection.call("teammate.archive", params: Params(id: id, archived: archived), as: Answer.self).teammate
    }

    /// Makes a teammate its space's Lead, or leaves the space with none; the space's teammates now.
    public func setLead(spaceId: String, id: String?) async throws -> [Teammate] {
        struct Params: Encodable, Sendable {
            let spaceId: String
            let id: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: Key.self)
                try c.encode(spaceId, forKey: .spaceId)
                try c.encode(id, forKey: .id)
            }
            enum Key: String, CodingKey { case spaceId, id }
        }
        struct Answer: Decodable, Sendable { let teammates: [Teammate] }
        return try await connection.call("teammates.setLead", params: Params(spaceId: spaceId, id: id), as: Answer.self).teammates
    }

    /// A space's Team list in a new order, every teammate in it; the space's teammates now.
    public func reorderTeam(spaceId: String, order: [TeamPlace]) async throws -> [Teammate] {
        struct Params: Encodable, Sendable { let spaceId: String; let order: [TeamPlace] }
        struct Answer: Decodable, Sendable { let teammates: [Teammate] }
        return try await connection.call("teammates.reorder", params: Params(spaceId: spaceId, order: order), as: Answer.self).teammates
    }

    /// The session that is a teammate's chat, made on the Mac when it has none yet.
    public func teammateChat(id: String) async throws -> String {
        struct Answer: Decodable, Sendable { let id: String }
        return try await connection.call("teammate.chat", params: SessionID(id: id), as: Answer.self).id
    }

    /// A teammate's Edit sheet, saved as the Mac's own sheet saves it; the teammate as it is now.
    public func updateTeammate(id: String, _ edit: TeammateEdit) async throws -> Teammate {
        struct Params: Encodable, Sendable {
            let id: String
            let edit: TeammateEdit
            func encode(to encoder: Encoder) throws {
                try edit.encode(to: encoder)
                var c = encoder.container(keyedBy: Key.self)
                try c.encode(id, forKey: .id)
            }
            enum Key: String, CodingKey { case id }
        }
        struct Answer: Decodable, Sendable { let teammate: Teammate }
        return try await connection.call("teammate.update", params: Params(id: id, edit: edit), as: Answer.self).teammate
    }

    /// Where a session runs, what it has cost, and its files: what its info sheet says beyond its row.
    public func info(id: String) async throws -> SessionInfo {
        try await connection.call("session.info", params: SessionID(id: id), as: SessionInfo.self)
    }

    /// Every agent's plan limits, and this month's spend.
    public func usage() async throws -> Usage {
        try await connection.call("usage.get", as: Usage.self)
    }

    /// What teams have handed back for review and is still open, newest first.
    public func reviews() async throws -> [ReviewSummary] {
        struct Answer: Decodable, Sendable { let reviews: [ReviewSummary] }
        return try await connection.call("reviews.list", as: Answer.self).reviews
    }

    public func review(id: String) async throws -> ReviewDetail {
        try await connection.call("review.get", params: SessionID(id: id), as: ReviewDetail.self)
    }

    /// Approves a review, asks for changes with a note, or rejects it with a reason. Approving posts
    /// nothing: each outward act is still pressed on the Mac.
    public func decide(review id: String, _ decision: ReviewDecision, note: String? = nil) async throws -> ReviewSummary {
        struct Params: Encodable, Sendable { let id: String; let decision: ReviewDecision; let note: String? }
        struct Answer: Decodable, Sendable { let review: ReviewSummary }
        return try await connection.call("review.decide", params: Params(id: id, decision: decision, note: note), as: Answer.self).review
    }

    /// A preview of a picture a review's item carries.
    public func reviewFile(id: String, path: String) async throws -> FilePreview {
        struct Params: Encodable, Sendable { let id: String; let path: String }
        return try await connection.call("review.file", params: Params(id: id, path: path), as: FilePreview.self)
    }

    /// Every space's scheduled tasks, next to run first.
    public func schedules() async throws -> [ScheduledTask] {
        struct Answer: Decodable, Sendable { let tasks: [ScheduledTask] }
        return try await connection.call("schedules.list", as: Answer.self).tasks
    }

    /// Runs a scheduled task now.
    public func runNow(schedule id: String) async throws -> ScheduledTask {
        struct Answer: Decodable, Sendable { let task: ScheduledTask }
        return try await connection.call("schedules.runNow", params: SessionID(id: id), as: Answer.self).task
    }

    public func debugReport(name: String, data: JSONValue) async throws {
        struct Params: Encodable, Sendable { let name: String; let data: JSONValue }
        _ = try await connection.call("debug.report", params: Params(name: name, data: data), as: Acknowledged.self)
    }

    private struct SessionID: Encodable, Sendable { let id: String }
    private struct QueuedID: Encodable, Sendable { let id: String; let queuedId: String }
}

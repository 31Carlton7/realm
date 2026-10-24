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

/// IK message 2's payload: `{"v":1,"mac":"<Mac name>","server":"<Realm version>"}`.
struct MacHello: Decodable {
    let v: Int
    let mac: String
    let server: String?
}

public struct ConnectedMac: Sendable, Equatable {
    public let name: String
    public let server: String
    /// IK message 1 sent → message 2 read: the Noise round trip through the relay and the Mac.
    public let handshake: Duration
    /// Socket created → channel ready: what a person waits for.
    public let connect: Duration
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
                let info = ConnectedMac(name: hello.mac, server: hello.server ?? "",
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
    public func send(id: String, text: String, delivery: Delivery? = nil, attachments: [AttachmentUpload] = [],
                     timeout: Duration? = nil) async throws {
        struct Params: Encodable, Sendable {
            let id: String
            let text: String
            let delivery: Delivery?
            let attachments: [AttachmentUpload]
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: Key.self)
                try c.encode(id, forKey: .id)
                try c.encode(text, forKey: .text)
                try c.encodeIfPresent(delivery, forKey: .delivery)
                // Left out when empty, so a message without files reads to an older Mac as it always did.
                if !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
            }
            enum Key: String, CodingKey { case id, text, delivery, attachments }
        }
        _ = try await connection.call("session.send", params: Params(id: id, text: text, delivery: delivery, attachments: attachments),
                                      as: Acknowledged.self, timeout: timeout)
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

    /// A space's own picture, for a space whose icon is one.
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

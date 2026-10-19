import Foundation

/// A Mac's presence as the relay reports it (§3.1 `ready`, §3.2 `mac`).
public struct MacPresence: Sendable, Equatable, Codable {
    public let online: Bool
    /// Unix milliseconds of the Mac's last message or heartbeat.
    public let lastSeen: Millis?

    public init(online: Bool, lastSeen: Millis?) {
        self.online = online
        self.lastSeen = lastSeen
    }
}

public enum RelayRole: Sendable {
    /// A paired phone. It answers the relay's challenge with its `sign` key.
    case phone(phoneId: String, identity: DeviceIdentity)
    /// A phone that is pairing. It sends no `auth`; the relay says `ready` straight away.
    case pairing(windowId: String)
}

public enum RelayEvent: Sendable, Equatable {
    /// The phone's `auth` is queued. Data sent from now on goes after it, so a client may pipeline.
    case authSent
    case ready(MacPresence?)
    case mac(MacPresence)
    case data(Data)
    /// A control message this client does not act on, as it arrived.
    case control(String)
    /// The last event: the socket closed, with the code and reason when anyone gave them.
    case closed(WebSocketClose?)
}

/// One socket to the relay (PROTOCOL.md §3): the challenge and `auth`, text for control and binary for
/// data, and the `ping` heartbeat. Reconnecting is the caller's job; a closed socket stays closed.
public actor RelaySocket {
    public static let heartbeatInterval: Duration = .seconds(20)

    public nonisolated let url: URL
    public nonisolated let events: AsyncStream<RelayEvent>
    private nonisolated let eventSink: AsyncStream<RelayEvent>.Continuation
    private nonisolated let outbox: AsyncStream<WebSocketMessage>.Continuation
    private let outgoing: AsyncStream<WebSocketMessage>
    private nonisolated let connection: any WebSocketConnection
    private let macId: String
    private let role: RelayRole
    private let heartbeat: Duration
    private let silenceLimit: Duration
    private var lastHeard = ContinuousClock.now
    private var tasks: [Task<Void, Never>] = []
    private var started = false
    private var finished = false
    private var localClose: WebSocketClose?

    public init(
        relay: URL,
        macId: String,
        role: RelayRole,
        factory: any WebSocketFactory,
        heartbeat: Duration = RelaySocket.heartbeatInterval,
        silenceLimit: Duration = .seconds(50)
    ) {
        url = Self.url(relay: relay, macId: macId, role: role)
        self.macId = macId
        self.role = role
        self.heartbeat = heartbeat
        self.silenceLimit = silenceLimit
        (events, eventSink) = AsyncStream.makeStream(of: RelayEvent.self, bufferingPolicy: .unbounded)
        (outgoing, outbox) = AsyncStream.makeStream(of: WebSocketMessage.self, bufferingPolicy: .unbounded)
        connection = factory.makeConnection(url: url)
    }

    /// `/v1/phone/<macId>/<phoneId>` or `/v1/pair/<macId>/<windowId>` under the relay base.
    public static func url(relay: URL, macId: String, role: RelayRole) -> URL {
        switch role {
        case .phone(let phoneId, _): relay.appending(path: "v1/phone/\(macId)/\(phoneId)")
        case .pairing(let windowId): relay.appending(path: "v1/pair/\(macId)/\(windowId)")
        }
    }

    public func start() {
        guard !started else { return }
        started = true
        lastHeard = .now
        connection.resume()
        tasks.append(Task { await self.readLoop() })
        tasks.append(Task { await self.writeLoop() })
        tasks.append(Task { await self.heartbeatLoop() })
    }

    /// Queues one binary data message. Messages leave in the order they were queued.
    public nonisolated func send(_ data: Data) {
        outbox.yield(.binary(data))
    }

    /// Queues a control message.
    public nonisolated func sendControl(_ object: some Encodable) {
        guard let json = try? JSONEncoder.realm.encode(object) else { return }
        outbox.yield(.text(String(decoding: json, as: UTF8.self)))
    }

    public func close(code: Int = 1000, reason: String? = nil) {
        guard !finished else { return }
        if localClose == nil { localClose = WebSocketClose(code: code, reason: reason) }
        connection.close(code: code, reason: reason)
        if !started { finish(localClose) }
    }

    // MARK: - Loops

    private func readLoop() async {
        while true {
            let message: WebSocketMessage
            do {
                message = try await connection.receive()
            } catch {
                finish(localClose ?? connection.closeInfo)
                return
            }
            lastHeard = .now
            switch message {
            case .text(let text): handleControl(text)
            case .binary(let data): eventSink.yield(.data(data))
            }
        }
    }

    private func writeLoop() async {
        for await message in outgoing {
            do {
                try await connection.send(message)
            } catch {
                // The reader sees the same failure and reports the close.
                return
            }
        }
    }

    private func heartbeatLoop() async {
        while !finished {
            do { try await Task.sleep(for: heartbeat) } catch { return }
            guard !finished else { return }
            if ContinuousClock.now - lastHeard > silenceLimit {
                close(code: 4000, reason: "The relay stopped answering")
                return
            }
            outbox.yield(.text("ping"))
        }
    }

    private func handleControl(_ text: String) {
        if text == "pong" { return }
        guard let object = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
              let type = object["t"]?.stringValue else {
            eventSink.yield(.control(text))
            return
        }
        switch type {
        case "challenge":
            guard case .phone(_, let identity) = role, let nonce = object["nonce"]?.stringValue,
                  let auth = try? identity.relayAuth(macId: macId, nonce: nonce) else {
                eventSink.yield(.control(text))
                return
            }
            sendControl(auth)
            eventSink.yield(.authSent)
        case "ready":
            eventSink.yield(.ready(Self.presence(object["mac"])))
        case "mac":
            if let presence = Self.presence(object) {
                eventSink.yield(.mac(presence))
            } else {
                eventSink.yield(.control(text))
            }
        default:
            eventSink.yield(.control(text))
        }
    }

    private static func presence(_ value: JSONValue?) -> MacPresence? {
        guard let value, let online = value["online"]?.boolValue else { return nil }
        return MacPresence(online: online, lastSeen: value["lastSeen"]?.numberValue)
    }

    private func finish(_ info: WebSocketClose?) {
        guard !finished else { return }
        finished = true
        outbox.finish()
        for task in tasks { task.cancel() }
        eventSink.yield(.closed(info))
        eventSink.finish()
    }
}

/// Exponential backoff with jitter, capped.
public struct Backoff: Sendable {
    public var base: Duration
    public var cap: Duration
    /// The share of each delay that is random: 0.3 waits between 70% and 100% of the step.
    public var jitter: Double

    public init(base: Duration = .milliseconds(500), cap: Duration = .seconds(30), jitter: Double = 0.3) {
        self.base = base
        self.cap = cap
        self.jitter = jitter
    }

    public func delay(attempt: Int, random: Double = Double.random(in: 0...1)) -> Duration {
        let step = min(cap, base * (1 << min(max(attempt, 0), 16)))
        return step * (1 - jitter + jitter * random)
    }
}

extension JSONEncoder {
    /// Plain JSON for the wire: `/` stays `/`.
    static var realm: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }
}

import CryptoKit
import Foundation
@testable import RealmKit
import Synchronization

/// One end of a socket whose far end is a `FakeRelay`.
final class FakeSocket: WebSocketConnection, @unchecked Sendable {
    let url: URL
    private let relay: FakeRelay

    private struct State {
        var queue: [WebSocketMessage] = []
        var waiter: CheckedContinuation<WebSocketMessage, Error>?
        var closed: WebSocketClose?
    }

    private let state = Mutex(State())

    init(url: URL, relay: FakeRelay) {
        self.url = url
        self.relay = relay
    }

    var role: String { url.pathComponents.count > 2 ? url.pathComponents[2] : "" }
    var pathIds: (String, String) { (url.pathComponents[3], url.pathComponents[4]) }

    func resume() {
        relay.opened(self)
    }

    func send(_ message: WebSocketMessage) async throws {
        if state.withLock({ $0.closed != nil }) { throw URLError(.networkConnectionLost) }
        relay.received(message, on: self)
    }

    func receive() async throws -> WebSocketMessage {
        try await withCheckedThrowingContinuation { continuation in
            let ready: Result<WebSocketMessage, Error>? = state.withLock { s in
                if !s.queue.isEmpty { return .success(s.queue.removeFirst()) }
                if s.closed != nil { return .failure(URLError(.networkConnectionLost)) }
                s.waiter = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready) }
        }
    }

    func close(code: Int, reason: String?) {
        shut(code: code, reason: reason)
    }

    var closeInfo: WebSocketClose? { state.withLock { $0.closed } }
    var isClosed: Bool { closeInfo != nil }

    /// The far end sends the phone a message.
    func deliver(_ message: WebSocketMessage) {
        let waiter: CheckedContinuation<WebSocketMessage, Error>? = state.withLock { s in
            guard s.closed == nil else { return nil }
            if let waiter = s.waiter {
                s.waiter = nil
                return waiter
            }
            s.queue.append(message)
            return nil
        }
        waiter?.resume(returning: message)
    }

    /// Closes the socket from either end.
    func shut(code: Int, reason: String? = nil) {
        let waiter: CheckedContinuation<WebSocketMessage, Error>? = state.withLock { s in
            guard s.closed == nil else { return nil }
            s.closed = WebSocketClose(code: code, reason: reason)
            let waiter = s.waiter
            s.waiter = nil
            return waiter
        }
        waiter?.resume(throwing: URLError(.networkConnectionLost))
    }
}

/// The relay and the Mac behind it, in one object, speaking PROTOCOL.md from the other side: the
/// challenge and its signature check, `ready`, the Mac's presence, IK and IKpsk1 as responder, frames,
/// and a handful of mobile.v1 calls.
final class FakeRelay: WebSocketFactory, @unchecked Sendable {
    enum PairAnswer: Sendable { case yes, declined }

    let relayURL = URL(string: "wss://relay.test")!
    let macDH = Curve25519.KeyAgreement.PrivateKey()
    let macSign = Curve25519.Signing.PrivateKey()
    let macName = "Fake Mac"
    var macId: String { deviceID(signPublicKey: macSign.publicKey.rawRepresentation) }

    private struct Channel {
        var phoneId: String?
        var windowId: String?
        var nonce = ""
        var send: CipherState?
        var receive: CipherState?
        var assembler = Frames.Assembler()
    }

    private struct Window {
        let id: String
        let secret: Data
        let answer: PairAnswer
    }

    struct Paired: Equatable {
        let name: String
        let model: String
        let phoneId: String
        let sign: Data
        let dh: Data
    }

    private struct State {
        var sockets: [FakeSocket] = []
        var channels: [ObjectIdentifier: Channel] = [:]
        var phones: [String: (sign: Data, dh: Data)] = [:]
        var paired: [Paired] = []
        var window: Window?
        var macOnline = true
        var holdReady = false
        var heldReady: [FakeSocket] = []
        var pings = 0
        var methods: [String] = []
        var pushTokens: [String] = []
        var seq = 100
    }

    private let state = Mutex(State())

    // MARK: - Test controls

    func register(_ identity: DeviceIdentity) {
        state.withLock { $0.phones[identity.id] = (identity.signPublicKey, identity.dhPublicKey) }
    }

    func pairedMac(for identity: DeviceIdentity, macKey: Data? = nil) -> PairedMac {
        PairedMac(macId: macId, macName: macName, relay: relayURL, macKey: macKey ?? macDH.publicKey.rawRepresentation,
                  phoneId: identity.id, windowId: "w", pairedAt: Date())
    }

    func openWindow(secret: Data, answer: PairAnswer) -> String {
        let id = Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        state.withLock { $0.window = Window(id: id, secret: secret, answer: answer) }
        return id
    }

    var socketCount: Int { state.withLock { $0.sockets.count } }
    var pings: Int { state.withLock { $0.pings } }
    var methods: [String] { state.withLock { $0.methods } }
    var pushTokens: [String] { state.withLock { $0.pushTokens } }
    var paired: [Paired] { state.withLock { $0.paired } }
    var openSockets: [FakeSocket] { state.withLock { $0.sockets.filter { !$0.isClosed } } }

    func holdReady(_ hold: Bool) {
        let release: [FakeSocket] = state.withLock { s in
            s.holdReady = hold
            if hold { return [] }
            defer { s.heldReady = [] }
            return s.heldReady
        }
        let online = state.withLock { $0.macOnline }
        for socket in release { socket.deliver(.text(Self.ready(online: online))) }
    }

    /// The Mac's socket goes away (its channel state with it) or comes back.
    func setMacOnline(_ online: Bool) {
        let phones: [FakeSocket] = state.withLock { s in
            s.macOnline = online
            if !online {
                for (id, var channel) in s.channels {
                    channel.send = nil
                    channel.receive = nil
                    channel.assembler = Frames.Assembler()
                    s.channels[id] = channel
                }
            }
            return s.sockets.filter { $0.role == "phone" && !$0.isClosed }
        }
        for socket in phones {
            socket.deliver(.text(#"{"t":"mac","online":\#(online),"lastSeen":1790000000000}"#))
        }
    }

    func dropAll(code: Int) {
        for socket in openSockets { socket.shut(code: code) }
    }

    /// Remove on the Mac: the relay closes the phone with 4410.
    func remove(_ phoneId: String) {
        let sockets: [FakeSocket] = state.withLock { s in
            s.phones[phoneId] = nil
            return s.sockets.filter { $0.role == "phone" && !$0.isClosed && $0.pathIds.1 == phoneId }
        }
        for socket in sockets { socket.shut(code: 4410) }
    }

    /// Sends an event to every open phone channel.
    func broadcast(_ json: String) {
        let targets: [FakeSocket] = state.withLock { s in s.sockets.filter { !$0.isClosed && s.channels[ObjectIdentifier($0)]?.send != nil } }
        for socket in targets { sendJSON(json, on: socket) }
    }

    // MARK: - WebSocketFactory

    func makeConnection(url: URL) -> any WebSocketConnection {
        let socket = FakeSocket(url: url, relay: self)
        state.withLock { $0.sockets.append(socket) }
        return socket
    }

    static func ready(online: Bool) -> String {
        #"{"t":"ready","mac":{"online":\#(online),"lastSeen":1790000000000}}"#
    }

    func opened(_ socket: FakeSocket) {
        switch socket.role {
        case "phone":
            let nonce = Base64URL.encode(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
            state.withLock { $0.channels[ObjectIdentifier(socket)] = Channel(nonce: nonce) }
            socket.deliver(.text(#"{"t":"challenge","nonce":"\#(nonce)"}"#))
        case "pair":
            let (macId, windowId) = socket.pathIds
            let open = state.withLock { s in s.window?.id == windowId && macId == self.macId }
            guard open else {
                socket.shut(code: 4403)
                return
            }
            state.withLock { $0.channels[ObjectIdentifier(socket)] = Channel(windowId: windowId) }
            socket.deliver(.text(Self.ready(online: true)))
        default:
            socket.shut(code: 4400)
        }
    }

    func received(_ message: WebSocketMessage, on socket: FakeSocket) {
        switch message {
        case .text("ping"):
            state.withLock { $0.pings += 1 }
            socket.deliver(.text("pong"))
        case .text(let text):
            let object = try? JSONDecoder().decode([String: String].self, from: Data(text.utf8))
            if object?["t"] == "apns", let token = object?["token"], let env = object?["env"] {
                state.withLock { $0.pushTokens.append("\(env):\(token)") }
            } else {
                authenticate(text, on: socket)
            }
        case .binary(let data):
            if socket.role == "pair" { pairingData(data, on: socket) } else { phoneData(data, on: socket) }
        }
    }

    // MARK: - The relay

    private func authenticate(_ text: String, on socket: FakeSocket) {
        guard let object = try? JSONDecoder().decode([String: String].self, from: Data(text.utf8)), object["t"] == "auth",
              let key = object["key"].flatMap(Base64URL.decode), let signature = object["sig"].flatMap(Base64URL.decode) else {
            socket.shut(code: 4400)
            return
        }
        let (macId, phoneId) = socket.pathIds
        let accepted: Bool = state.withLock { s in
            guard let channel = s.channels[ObjectIdentifier(socket)], let phone = s.phones[phoneId], phone.sign == key,
                  deviceID(signPublicKey: key) == phoneId, macId == self.macId,
                  let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
                  publicKey.isValidSignature(signature, for: DeviceIdentity.relayChallengeMessage(
                      role: "phone", macId: macId, phoneId: phoneId, nonce: channel.nonce)) else { return false }
            s.channels[ObjectIdentifier(socket)]?.phoneId = phoneId
            return true
        }
        guard accepted else {
            socket.shut(code: 4401)
            return
        }
        let (hold, online) = state.withLock { s in
            if s.holdReady { s.heldReady.append(socket) }
            return (s.holdReady, s.macOnline)
        }
        if !hold { socket.deliver(.text(Self.ready(online: online))) }
    }

    // MARK: - The Mac

    private func phoneData(_ data: Data, on socket: FakeSocket) {
        let id = ObjectIdentifier(socket)
        let (channel, online, phone) = state.withLock { s in
            (s.channels[id], s.macOnline, s.channels[id]?.phoneId.flatMap { s.phones[$0] })
        }
        guard var channel, let phoneId = channel.phoneId, let phone else {
            socket.shut(code: 4401)
            return
        }
        guard online else {
            socket.deliver(.text(#"{"t":"mac","online":false,"lastSeen":1790000000000}"#))
            return
        }
        if channel.send == nil {
            do {
                var handshake = try HandshakeState(pattern: .IK, initiator: false, prologue: Prologue.ik(macId: macId, phoneId: phoneId),
                                                   localStatic: macDH, remoteStatic: nil)
                _ = try handshake.readMessage(data)
                guard handshake.remoteStatic == phone.dh else { throw NoiseError.invalidKey }
                let answer = try handshake.writeMessage(Data(#"{"v":1,"mac":"\#(macName)","server":"test","extra":true}"#.utf8))
                let ciphers = try handshake.split()
                channel.send = ciphers.responderToInitiator
                channel.receive = ciphers.initiatorToResponder
                state.withLock { $0.channels[id] = channel }
                socket.deliver(.binary(answer))
            } catch {
                socket.shut(code: 4000)
            }
            return
        }
        guard var receive = channel.receive else { return }
        let message: Data?
        do {
            message = try channel.assembler.open(data, with: &receive)
        } catch {
            socket.shut(code: 4000)
            return
        }
        channel.receive = receive
        state.withLock { $0.channels[id] = channel }
        guard let message, let request = try? JSONDecoder().decode(Request.self, from: message) else { return }
        state.withLock { $0.methods.append(request.method) }
        switch request.method {
        case "ping":
            sendJSON(#"{"id":\#(request.id),"ok":true,"result":{"at":1790000000123}}"#, on: socket)
        case "home.get":
            sendJSON(#"{"id":\#(request.id),"ok":true,"result":{"mac":{"name":"\#(macName)"},"needsYou":[],"spaces":[{"id":"sp","name":"Space","icon":"🌊","color":"blue","more":0,"sessions":[{"id":"s1","title":"First","spaceId":"sp","spaceName":"Space","agent":"fake","model":null,"status":"idle","needsYou":false,"unread":false,"updatedAt":1}]}]}}"#, on: socket)
        case "session.open":
            sendJSON(#"{"id":\#(request.id),"ok":true,"result":{"session":{"id":"s1","title":"First","spaceId":"sp","spaceName":"Space","agent":"fake","model":null,"status":"idle","needsYou":false,"unread":false,"updatedAt":1},"rows":[{"key":"u:1","seq":1,"kind":"user","text":"hello"}],"hasMore":false}}"#, on: socket)
        case "session.send":
            let seq = state.withLock { s in
                s.seq += 1
                return s.seq
            }
            let text = request.params?["text"]?.stringValue ?? ""
            sendJSON(#"{"id":\#(request.id),"ok":true,"result":{"ok":true}}"#, on: socket)
            let row = try! JSONEncoder().encode(["key": "u:\(seq)", "kind": "user", "text": text])
            let rowJSON = String(decoding: row, as: UTF8.self).dropLast() + #","seq":\#(seq)}"#
            sendJSON(#"{"event":"session.rows","payload":{"id":"s1","rows":[\#(rowJSON)]}}"#, on: socket)
        case "slow":
            break
        default:
            sendJSON(#"{"id":\#(request.id),"ok":false,"error":{"code":"METHOD_NOT_FOUND","message":"\#(request.method)"}}"#, on: socket)
        }
    }

    private struct Request: Decodable {
        let id: Int
        let method: String
        let params: [String: JSONValue]?
    }

    private func sendJSON(_ json: String, on socket: FakeSocket) {
        let id = ObjectIdentifier(socket)
        let frames: [Data]? = state.withLock { s in
            guard var send = s.channels[id]?.send, let frames = try? Frames.seal(Data(json.utf8), with: &send) else { return nil }
            s.channels[id]?.send = send
            return frames
        }
        for frame in frames ?? [] { socket.deliver(.binary(frame)) }
    }

    private func pairingData(_ data: Data, on socket: FakeSocket) {
        let id = ObjectIdentifier(socket)
        guard let window = state.withLock({ $0.window }), state.withLock({ $0.channels[id]?.send == nil }) else { return }
        do {
            var handshake = try HandshakeState(pattern: .IKpsk1, initiator: false, prologue: Prologue.pair(macId: macId, windowId: window.id),
                                               localStatic: macDH, remoteStatic: nil, preSharedKey: window.secret)
            let hello = try JSONDecoder().decode([String: JSONValue].self, from: try handshake.readMessage(data))
            guard hello["v"] == .number(1), let sign = hello["sign"]?.stringValue.flatMap(Base64URL.decode),
                  let dh = handshake.remoteStatic else { throw NoiseError.invalidKey }
            let answer = try handshake.writeMessage(Data(#"{"v":1,"mac":"\#(macName)"}"#.utf8))
            let ciphers = try handshake.split()
            state.withLock { $0.channels[id]?.send = ciphers.responderToInitiator }
            socket.deliver(.binary(answer))
            let phoneId = deviceID(signPublicKey: sign)
            switch window.answer {
            case .yes:
                state.withLock { s in
                    s.phones[phoneId] = (sign, dh)
                    s.paired.append(Paired(name: hello["name"]?.stringValue ?? "", model: hello["model"]?.stringValue ?? "",
                                           phoneId: phoneId, sign: sign, dh: dh))
                    s.window = nil
                }
                sendJSON(#"{"event":"pair.result","payload":{"ok":true,"phoneId":"\#(phoneId)"}}"#, on: socket)
            case .declined:
                sendJSON(#"{"event":"pair.result","payload":{"ok":false,"reason":"declined"}}"#, on: socket)
            }
            socket.shut(code: 4000)
        } catch {
            socket.shut(code: 4000)
        }
    }
}

/// Polls until `condition` holds or the time is up.
func eventually(_ timeout: Duration = .seconds(5), _ condition: @Sendable () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}

import CryptoKit
import Foundation

/// What the phone tells the Mac about itself when pairing.
public struct PairingDevice: Sendable, Equatable {
    public let name: String
    public let model: String

    public init(name: String, model: String) {
        self.name = name
        self.model = model
    }
}

/// IKpsk1 message 1's payload: `{"v":1,"name":"<device name>","model":"<model identifier>","sign":"<b64u signPub>"}`.
struct PairingHello: Encodable {
    let v = 1
    let name: String
    let model: String
    let sign: String
}

/// IKpsk1 message 2's payload: `{"v":1,"mac":"<Mac name>"}`.
struct PairingAnswer: Decodable {
    let v: Int
    let mac: String
}

public enum PairingProgress: Sendable, Equatable {
    case connecting
    /// The Mac opened message 1 and is asking its owner.
    case confirmOnMac(macName: String)
}

public enum PairingError: Error, Equatable, Sendable {
    case linkExpired
    /// The relay refused the socket: no window open with that id, or its attempts are used up.
    case windowClosed
    /// The Mac closed the channel without answering message 1, as it does when the secret is wrong.
    case notAnswered
    /// Message 2 did not open: the answer did not come from the key in the link.
    case wrongMac
    case declined
    /// Nobody answered on the Mac in time.
    case expired
    case unexpectedAnswer(String)
    case connectionLost(code: Int?)
    case timedOut
}

/// The pairing flow of PROTOCOL.md §4.1, over `/v1/pair/<macId>/<windowId>`.
public enum Pairing {
    public static func run(
        link: PairingLink,
        identity: DeviceIdentity,
        device: PairingDevice,
        factory: any WebSocketFactory = URLSessionWebSocketFactory(),
        now: Date = Date(),
        timeout: Duration = .seconds(11 * 60),
        progress: @escaping @Sendable (PairingProgress) -> Void = { _ in },
        ephemeral: Curve25519.KeyAgreement.PrivateKey? = nil
    ) async throws(PairingError) -> PairedMac {
        guard !link.isExpired(at: now) else { throw .linkExpired }
        let socket = RelaySocket(relay: link.relay, macId: link.macId, role: .pairing(windowId: link.windowId), factory: factory)
        let started = ContinuousClock.now
        let timer = Task {
            try? await Task.sleep(for: timeout)
            await socket.close(code: 1000, reason: "Pairing timed out")
        }
        defer { timer.cancel() }
        progress(.connecting)
        await socket.start()

        var handshake: HandshakeState
        do {
            handshake = try HandshakeState(
                pattern: .IKpsk1, initiator: true,
                prologue: Prologue.pair(macId: link.macId, windowId: link.windowId),
                localStatic: identity.dh, remoteStatic: link.macKey, preSharedKey: link.secret,
                localEphemeral: ephemeral
            )
        } catch {
            await socket.close()
            throw .unexpectedAnswer("could not start the handshake")
        }
        var sentHello = false
        var receive: CipherState?
        var assembler = Frames.Assembler()
        var macName = link.macName
        var outcome: Result<PairedMac, PairingError>?

        func sendHello() throws {
            let hello = PairingHello(name: device.name, model: device.model, sign: Base64URL.encode(identity.signPublicKey))
            socket.send(try handshake.writeMessage(try JSONEncoder.realm.encode(hello)))
            sentHello = true
        }

        for await event in socket.events {
            switch event {
            case .ready(let presence):
                // The relay accepted the socket for this window. Speak once the Mac is there to hear it.
                if !sentHello, presence?.online != false { try? sendHello() }
            case .mac(let presence):
                if !sentHello, presence.online { try? sendHello() }
            case .data(let bytes):
                if receive == nil {
                    do {
                        let answer = try JSONDecoder().decode(PairingAnswer.self, from: try handshake.readMessage(bytes))
                        receive = try handshake.split().responderToInitiator
                        macName = answer.mac
                        progress(.confirmOnMac(macName: macName))
                    } catch {
                        outcome = .failure(.wrongMac)
                        await socket.close(code: 4000, reason: "The Mac's answer did not open")
                    }
                    continue
                }
                guard outcome == nil, var cipher = receive else { continue }
                do {
                    let message = try assembler.open(bytes, with: &cipher)
                    receive = cipher
                    guard let message else { continue }
                    guard case .event(.pairResult(let result)) = Envelope.classify(message) else { continue }
                    if result.ok && result.phoneId == identity.id {
                        outcome = .success(PairedMac(
                            macId: link.macId, macName: macName, relay: link.relay, macKey: link.macKey,
                            phoneId: identity.id, windowId: link.windowId, pairedAt: Date()
                        ))
                    } else if result.ok {
                        outcome = .failure(.unexpectedAnswer("the Mac recorded this iPhone as \(result.phoneId ?? "nothing")"))
                    } else {
                        outcome = .failure(result.reason == "declined" ? .declined : .expired)
                    }
                    // The Mac closes the channel after its answer; do not wait on it.
                    await socket.close()
                } catch {
                    outcome = .failure(.unexpectedAnswer("a frame did not open"))
                    await socket.close(code: 4000, reason: "A frame did not open")
                }
            case .closed(let info):
                if outcome != nil { break }
                if info?.code == 4403 {
                    outcome = .failure(.windowClosed)
                } else if ContinuousClock.now - started >= timeout {
                    outcome = .failure(.timedOut)
                } else if sentHello && receive == nil {
                    outcome = .failure(.notAnswered)
                } else {
                    outcome = .failure(.connectionLost(code: info?.code))
                }
            case .authSent, .control:
                break
            }
        }
        switch outcome {
        case .success(let mac): return mac
        case .failure(let error): throw error
        case nil: throw .connectionLost(code: nil)
        }
    }
}

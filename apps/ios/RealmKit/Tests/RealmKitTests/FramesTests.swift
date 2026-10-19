import Foundation
@testable import RealmKit
import Testing

@Suite("Transport framing (§5)")
struct FramesTests {
    static let key = Data(repeating: 0x42, count: 32)

    func roundTrip(_ message: Data) throws -> (frames: [Data], opened: Data?) {
        var send = CipherState(key: Self.key)
        var receive = CipherState(key: Self.key)
        var assembler = Frames.Assembler()
        let frames = try Frames.seal(message, with: &send)
        var opened: Data?
        for (index, frame) in frames.enumerated() {
            let result = try assembler.open(frame, with: &receive)
            if index < frames.count - 1 { #expect(result == nil) } else { opened = result }
        }
        return (frames, opened)
    }

    @Test func aSmallMessageIsOneFrame() throws {
        let message = Data(#"{"id":1,"method":"ping","params":{}}"#.utf8)
        let (frames, opened) = try roundTrip(message)
        #expect(frames.count == 1)
        #expect(frames[0].count == message.count + 1 + 16)
        #expect(opened == message)
    }

    @Test func anEmptyMessageIsOneFinalFrame() throws {
        let (frames, opened) = try roundTrip(Data())
        #expect(frames.count == 1)
        #expect(opened == Data())
    }

    @Test func boundariesFallOnTheFragmentLimit() throws {
        #expect(Frames.maxFragment == 65_518)
        let exact = try roundTrip(Data(repeating: 0x61, count: 65_518))
        #expect(exact.frames.map(\.count) == [65_535])
        let over = try roundTrip(Data(repeating: 0x61, count: 65_519))
        #expect(over.frames.map(\.count) == [65_535, 18])
        #expect(over.opened?.count == 65_519)
    }

    @Test func aMessageOver150KBCrossesAsSeveralFramesAndJoins() throws {
        let rows = (0..<1_500).map { #"{"key":"e:\#($0)","seq":\#($0),"kind":"notice","text":"Row \#($0) — ünïcode and padding padding padding"}"# }
        let message = Data(#"{"event":"session.rows","payload":{"id":"s","rows":[\#(rows.joined(separator: ","))]}}"#.utf8)
        #expect(message.count > 150_000)
        let (frames, opened) = try roundTrip(message)
        #expect(frames.count == (message.count + Frames.maxFragment - 1) / Frames.maxFragment)
        #expect(frames.allSatisfy { $0.count <= Frames.maxCiphertext })
        #expect(opened == message)
        #expect(try JSONSerialization.jsonObject(with: try #require(opened)) is [String: Any])
    }

    @Test func messagesFollowEachOtherOnOneCipher() throws {
        var send = CipherState(key: Self.key)
        var receive = CipherState(key: Self.key)
        var assembler = Frames.Assembler()
        let messages = [Data(repeating: 1, count: 70_000), Data("small".utf8), Data(repeating: 2, count: 140_000)]
        var opened: [Data] = []
        for message in messages {
            for frame in try Frames.seal(message, with: &send) {
                if let whole = try assembler.open(frame, with: &receive) { opened.append(whole) }
            }
        }
        #expect(opened == messages)
    }

    @Test func framesOutOfOrderDoNotOpen() throws {
        var send = CipherState(key: Self.key)
        var receive = CipherState(key: Self.key)
        var assembler = Frames.Assembler()
        let frames = try Frames.seal(Data(repeating: 3, count: 100_000), with: &send)
        #expect(throws: NoiseError.decryptFailed) { try assembler.open(frames[1], with: &receive) }
    }

    @Test func anUnknownFlagIsRefused() throws {
        var send = CipherState(key: Self.key)
        var receive = CipherState(key: Self.key)
        var assembler = Frames.Assembler()
        let frame = try send.encrypt(Data([0x02]) + Data("x".utf8))
        #expect(throws: FrameError.unknownFlag(0x02)) { try assembler.open(frame, with: &receive) }
    }

    @Test func aFrameWithNoFlagIsRefused() throws {
        var send = CipherState(key: Self.key)
        var receive = CipherState(key: Self.key)
        var assembler = Frames.Assembler()
        let frame = try send.encrypt(Data())
        #expect(throws: FrameError.emptyFrame) { try assembler.open(frame, with: &receive) }
    }

    @Test func anOversizedFrameIsRefusedBeforeDecrypting() throws {
        var receive = CipherState(key: Self.key)
        var assembler = Frames.Assembler()
        #expect(throws: FrameError.frameTooLarge(65_536)) { try assembler.open(Data(count: 65_536), with: &receive) }
        #expect(receive.nonce == 0)
    }
}

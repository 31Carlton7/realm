import Foundation

/// Whatever carries an outgoing item to the Mac: `MobileAPI` in the app, a script in tests.
public protocol OutboxTransport: Sendable {
    /// `files`: a message's attachments, read from where they waited.
    func deliver(_ item: OutgoingItem, files: [AttachmentUpload]) async throws
}

extension MobileAPI: OutboxTransport {
    /// Long enough for a cold cellular radio. A later answer leaves the item unconfirmed, not failed.
    public static let deliveryTimeout: Duration = .seconds(30)

    /// A message's files go up at the pace of a slow uplink, 128 KB a second, on top of the radio's
    /// wait: ten megabytes of photos get a little over two minutes.
    public static func deliveryTimeout(for files: [AttachmentUpload]) -> Duration {
        let bytes = files.reduce(0) { $0 + $1.data.utf8.count }
        return deliveryTimeout + .milliseconds(bytes / 128)
    }

    public func deliver(_ item: OutgoingItem, files: [AttachmentUpload]) async throws {
        switch item.payload {
        case .message(let text):
            try await send(id: item.sessionId, text: text, delivery: item.delivery, attachments: files,
                           timeout: Self.deliveryTimeout(for: files))
        case .answer(let requestId, let decision, let answers):
            try await answer(id: item.sessionId, requestId: requestId, decision: decision,
                             values: item.answerValues ?? answers?.mapValues(AnswerValue.one), timeout: Self.deliveryTimeout)
        }
    }
}

/// Sends what waits in the outbox: a session's items one at a time, in the order they were given,
/// until one cannot go. Nothing is dropped for taking long; an item whose fate is unknown is looked
/// for in the live transcript before it is sent again, so it never arrives twice.
@MainActor
public final class Courier {
    public enum Outcome: Sendable, Equatable {
        /// Nothing of the session's is left to send.
        case done
        /// The channel could not take it: wait for the next connection.
        case waitingForMac
        /// Its fate is unknown, and the transcript must be looked at before it goes again.
        case unconfirmed
    }

    private let store: RealmStore
    private var running: Set<String> = []
    /// The Mac took an item. Answers confirm with a light haptic here, not when the button is pressed.
    public var onAccepted: (OutgoingItem) -> Void = { _ in }

    public init(store: RealmStore) {
        self.store = store
    }

    public func isDelivering(_ sessionId: String) -> Bool {
        running.contains(sessionId)
    }

    @discardableResult
    public func deliver(_ sessionId: String, via transport: any OutboxTransport, now: () -> Date = Date.init) async -> Outcome {
        guard running.insert(sessionId).inserted else { return .done }
        defer { running.remove(sessionId) }
        store.settleOutbox(in: sessionId)
        while let item = store.outbox.next(in: sessionId) {
            if now().timeIntervalSince(item.createdAt) > OutgoingItem.maxAge {
                store.setOutgoing(item.id, .failed("Not sent: it waited more than a day for your Mac."))
                continue
            }
            // It may already be on the Mac. Whatever arrived was settled against the transcript above and
            // as its rows came in; only a transcript fresh from this connection can say it never did.
            if item.state == .unconfirmed, store.transcripts[sessionId]?.isLive != true { return .unconfirmed }
            let files: [AttachmentUpload]
            do {
                files = try store.files.uploads(for: item)
            } catch OutboxFiles.Problem.missing(let name) {
                store.setOutgoing(item.id, .failed("\(name) is no longer on this iPhone."))
                continue
            } catch {
                // Locked away while the phone is: it goes on the next try once it is unlocked.
                return .waitingForMac
            }
            store.setOutgoing(item.id, .sending)
            do {
                try await transport.deliver(item, files: files)
                // Its row may have come first and settled it already.
                if store.outbox.item(item.id) != nil { store.setOutgoing(item.id, .delivered) }
                store.settleOutbox(in: sessionId)
                onAccepted(item)
            } catch ChannelError.rpc(let error) {
                store.setOutgoing(item.id, .failed(error.message))
            } catch ChannelError.badResponse {
                store.setOutgoing(item.id, .failed("Your Mac sent an answer this app cannot read. Update Realm on both."))
            } catch ChannelError.notConnected {
                // Refused before a byte was written: it is still exactly where it was.
                store.setOutgoing(item.id, .waiting)
                return .waitingForMac
            } catch {
                // Timed out, or the channel dropped with it written: it may be on the Mac.
                store.setOutgoing(item.id, .unconfirmed)
                return .unconfirmed
            }
        }
        return .done
    }
}

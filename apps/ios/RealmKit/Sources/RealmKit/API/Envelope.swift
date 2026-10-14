import Foundation

// PROTOCOL.md §6: the desktop RPC's envelope.
//   request   {"id":<int>,"method":"<name>","params":{…}}
//   response  {"id":<int>,"ok":true,"result":…} | {"id":<int>,"ok":false,"error":{"code","message"}}
//   event     {"event":"<name>","payload":{…}}

public struct EmptyParams: Codable, Sendable, Equatable {
    public init() {}
}

public struct RPCError: Error, Decodable, Sendable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

struct RequestEnvelope<Params: Encodable>: Encodable {
    let id: Int
    let method: String
    let params: Params
}

struct ResponseEnvelope<Result: Decodable>: Decodable {
    let ok: Bool
    let result: Result?
    let error: RPCError?
}

struct EventEnvelope<Payload: Decodable>: Decodable {
    let payload: Payload
}

public enum IncomingMessage: Sendable {
    case response(id: Int)
    case event(MobileEvent)
    case unrecognized
}

public enum Envelope {
    private struct Header: Decodable {
        let id: Int?
        let event: String?

        private enum CodingKeys: String, CodingKey { case id, event }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            event = try? c.decodeIfPresent(String.self, forKey: .event)
            if let number = try? c.decodeIfPresent(Int.self, forKey: .id) {
                id = number
            } else if let text = try? c.decodeIfPresent(String.self, forKey: .id) {
                // The desktop's RPC answers with the id it parsed; a string id that is a number is the same call.
                id = Int(text)
            } else {
                id = nil
            }
        }
    }

    public static func classify(_ message: Data) -> IncomingMessage {
        guard let header = try? JSONDecoder().decode(Header.self, from: message) else { return .unrecognized }
        if let name = header.event { return .event(event(named: name, from: message)) }
        if let id = header.id { return .response(id: id) }
        return .unrecognized
    }

    private static func event(named name: String, from message: Data) -> MobileEvent {
        func payload<Payload: Decodable>(_ type: Payload.Type) -> Payload? {
            try? JSONDecoder().decode(EventEnvelope<Payload>.self, from: message).payload
        }
        switch name {
        case "session.rows": return payload(SessionRowsEvent.self).map(MobileEvent.sessionRows) ?? .unknown(name: name)
        case "session.status": return payload(SessionStatusEvent.self).map(MobileEvent.sessionStatus) ?? .unknown(name: name)
        case "home.changed": return .homeChanged
        case "pair.result": return payload(PairResult.self).map(MobileEvent.pairResult) ?? .unknown(name: name)
        default: return .unknown(name: name)
        }
    }

    /// The result of a response, or the error it carries.
    public static func result<Result: Decodable>(_ type: Result.Type, from message: Data) throws -> Result {
        let response: ResponseEnvelope<Result>
        do {
            response = try JSONDecoder().decode(ResponseEnvelope<Result>.self, from: message)
        } catch {
            throw ChannelError.badResponse(String(describing: error))
        }
        if response.ok, let result = response.result { return result }
        if let error = response.error { throw ChannelError.rpc(error) }
        throw ChannelError.badResponse("a response with neither a result nor an error")
    }

    static func request(id: Int, method: String, params: some Encodable) throws -> Data {
        try JSONEncoder.realm.encode(RequestEnvelope(id: id, method: method, params: params))
    }
}

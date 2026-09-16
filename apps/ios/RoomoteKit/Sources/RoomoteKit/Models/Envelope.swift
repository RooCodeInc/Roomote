import Foundation

/// Untyped task transcript envelope with best-effort accessors.
public struct Envelope: Codable, Sendable, Hashable, Identifiable {
    public var raw: JSONValue
    public var id: String
    public var ts: Double?
    public var eventType: String?

    public init(raw: JSONValue) {
        self.raw = raw
        let ts = raw["ts"]?.doubleValue
            ?? raw["timestamp"]?.doubleValue
            ?? raw["createdAt"]?.stringValue.flatMap(ISO8601.date(from:)).map { $0.timeIntervalSince1970 * 1000 }
        self.ts = ts
        eventType = raw["eventType"]?.stringValue ?? raw["type"]?.stringValue ?? raw["event"]?.stringValue
        let explicitId = raw["id"]?.stringValue
            ?? raw["id"]?.doubleValue.map { String(Int64($0)) }
            ?? raw["eventId"]?.stringValue
            ?? raw["messageId"]?.stringValue
        id = explicitId ?? "\(eventType ?? "event")-\(ts.map { String(Int64($0)) } ?? UUID().uuidString)"
    }

    public init(from decoder: Decoder) throws {
        self.init(raw: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }

    public var date: Date? { ts.map { Date(timeIntervalSince1970: $0 / 1000) } }

    public var role: String? { raw["role"]?.stringValue }

    public var typedEventType: MessageEventType? { eventType.flatMap(MessageEventType.init(rawValue:)) }

    public var isUserPrompt: Bool { typedEventType == .userPrompt || role == "user" }
    public var isAssistantMessage: Bool { typedEventType == .assistantMessage || typedEventType == .assistantMessageChunk }

    /// Extracts human-readable text from the common envelope shapes.
    public var text: String? {
        if let blocks = raw["contentBlocks"]?.arrayValue ?? raw["content"]?.arrayValue {
            let parts = blocks.compactMap { block -> String? in
                guard block["type"]?.stringValue ?? "text" == "text" else { return nil }
                return block["text"]?.stringValue
            }
            if !parts.isEmpty { return parts.joined(separator: "\n") }
        }
        let candidates = [
            raw["text"]?.stringValue,
            raw["content"]?.stringValue,
            raw["message"]?.stringValue,
            raw["delta"]?.stringValue,
            raw["payload"]?["text"]?.stringValue,
            raw["payload"]?["message"]?.stringValue,
            raw["payload"]?["output"]?.stringValue,
            raw["payload"]?["title"]?.stringValue,
        ]
        return candidates.compactMap { $0 }.first(where: { !$0.isEmpty })
    }

    public var isToolEvent: Bool {
        switch typedEventType {
        case .userPrompt, .assistantMessage, .assistantMessageChunk, .requestUserInput, .capabilityOffer, .taskCancelled:
            false
        default:
            true
        }
    }

    public var toolTitle: String {
        let payload = raw["payload"]
        let candidates = [
            payload?["title"]?.stringValue,
            payload?["mcpToolName"]?.stringValue,
            payload?["toolName"]?.stringValue,
            payload?["command"]?.stringValue,
            raw["title"]?.stringValue,
        ]
        return candidates.compactMap { $0 }.first(where: { !$0.isEmpty })
            ?? typedEventType?.shortName
            ?? (eventType ?? "event").replacingOccurrences(of: "roomote_runtime.", with: "")
    }

    public var userInputRequest: UserInputRequest? {
        guard typedEventType == .requestUserInput, let payload = raw["payload"] else { return nil }
        return payload.decode(UserInputRequest.self)
    }
}

public struct TranscriptPage: Codable, Sendable {
    public var envelopes: [Envelope]
    public var nextCursor: String?

    public init(envelopes: [Envelope], nextCursor: String? = nil) {
        self.envelopes = envelopes
        self.nextCursor = nextCursor
    }

    // The server names the page `messages`; `envelopes` is kept for older builds.
    enum CodingKeys: String, CodingKey { case envelopes, messages, nextCursor }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        envelopes = try container.decodeIfPresent([Envelope].self, forKey: .messages)
            ?? container.decodeIfPresent([Envelope].self, forKey: .envelopes)
            ?? []
        nextCursor = try container.decodeIfPresent(JSONValue.self, forKey: .nextCursor).flatMap(Cursor.string(from:))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(envelopes, forKey: .messages)
        try container.encodeIfPresent(nextCursor, forKey: .nextCursor)
    }
}

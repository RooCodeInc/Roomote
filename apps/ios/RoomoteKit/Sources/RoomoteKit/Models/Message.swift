import Foundation

/// ACP event types the app renders specially. Everything else is a tool row.
public enum MessageEventType: String, Sendable {
    case userPrompt = "roomote_runtime.user_prompt"
    case assistantMessage = "roomote_runtime.assistant_message"
    case assistantMessageChunk = "roomote_runtime.assistant_message_chunk"
    case requestUserInput = "roomote_runtime.request_user_input"
    case requestUserInputResponse = "roomote_runtime.request_user_input_response"
    case capabilityOffer = "roomote_runtime.capability_offer"
    case capabilityOfferResponse = "roomote_runtime.capability_offer_response"
    case toolCall = "roomote_runtime.tool_call"
    case toolCallUpdate = "roomote_runtime.tool_call_update"
    case toolResult = "roomote_runtime.tool_result"
    case taskCancelled = "roomote_runtime.task_cancelled"
}

public struct ContentBlock: Codable, Sendable, Hashable {
    public var raw: JSONValue

    public init(raw: JSONValue) { self.raw = raw }

    public init(text: String) {
        raw = .object(["type": .string("text"), "text": .string(text)])
    }

    public init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try raw.encode(to: encoder)
    }

    public var type: String { raw["type"]?.stringValue ?? "" }
    public var text: String? { raw["text"]?.stringValue }

    /// Best-effort image reference for `image` blocks (URL or data URL).
    public var imageURL: URL? {
        guard type == "image" else { return nil }
        let candidates = [
            raw["url"]?.stringValue,
            raw["uri"]?.stringValue,
            raw["source"]?["url"]?.stringValue,
            raw["data"]?.stringValue.map { data -> String in
                if data.hasPrefix("data:") { return data }
                let mime = raw["mimeType"]?.stringValue ?? raw["media_type"]?.stringValue ?? "image/png"
                return "data:\(mime);base64,\(data)"
            },
        ]
        return candidates.compactMap { $0 }.compactMap(URL.init(string:)).first
    }
}

public struct Message: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var eventId: String
    public var turnId: String
    public var turnSeq: Int
    public var ts: Double
    public var eventType: String
    public var role: String?
    public var contentBlocks: [ContentBlock]?
    public var payload: JSONValue?
    public var userName: String?
    public var userImageUrl: String?
    public var createdAt: Date

    public init(
        id: String,
        eventId: String? = nil,
        turnId: String = "",
        turnSeq: Int = 0,
        ts: Double,
        eventType: String,
        role: String? = nil,
        contentBlocks: [ContentBlock]? = nil,
        payload: JSONValue? = nil,
        userName: String? = nil,
        userImageUrl: String? = nil,
        createdAt: Date? = nil
    ) {
        self.id = id
        self.eventId = eventId ?? id
        self.turnId = turnId
        self.turnSeq = turnSeq
        self.ts = ts
        self.eventType = eventType
        self.role = role
        self.contentBlocks = contentBlocks
        self.payload = payload
        self.userName = userName
        self.userImageUrl = userImageUrl
        self.createdAt = createdAt ?? Date(timeIntervalSince1970: ts / 1000)
    }

    enum CodingKeys: String, CodingKey {
        case id, eventId, turnId, turnSeq, ts, eventType, role, contentBlocks, payload, userName, userImageUrl, createdAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        eventId = try container.decodeIfPresent(String.self, forKey: .eventId) ?? id
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId) ?? ""
        turnSeq = try container.decodeIfPresent(Int.self, forKey: .turnSeq)
            ?? container.decodeIfPresent(Double.self, forKey: .turnSeq).map(Int.init) ?? 0
        ts = try container.decodeIfPresent(Double.self, forKey: .ts) ?? 0
        eventType = try container.decodeIfPresent(String.self, forKey: .eventType) ?? ""
        role = try container.decodeIfPresent(String.self, forKey: .role)
        contentBlocks = try container.decodeIfPresent([ContentBlock].self, forKey: .contentBlocks)
        payload = try container.decodeIfPresent(JSONValue.self, forKey: .payload)
        if payload?.isNull == true { payload = nil }
        userName = try container.decodeIfPresent(String.self, forKey: .userName)
        userImageUrl = try container.decodeIfPresent(String.self, forKey: .userImageUrl)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
            ?? Date(timeIntervalSince1970: ts / 1000)
    }

    // MARK: Typed accessors

    public var typedEventType: MessageEventType? { MessageEventType(rawValue: eventType) }

    public var isUserPrompt: Bool { typedEventType == .userPrompt || (typedEventType == nil && role == "user") }
    public var isAssistantMessage: Bool { typedEventType == .assistantMessage }

    /// Tool calls, updates, results, and anything the app does not render on its own.
    public var isToolEvent: Bool {
        switch typedEventType {
        case .userPrompt, .assistantMessage, .requestUserInput, .capabilityOffer, .taskCancelled:
            false
        case .assistantMessageChunk, .requestUserInputResponse, .capabilityOfferResponse:
            false
        case .toolCall, .toolCallUpdate, .toolResult, .none:
            true
        }
    }

    public var isCancelled: Bool { typedEventType == .taskCancelled }

    /// Concatenated text of the `text` content blocks, or nil when there is none.
    public var text: String? {
        let parts = (contentBlocks ?? []).compactMap { block -> String? in
            guard block.type == "text", let text = block.text else { return nil }
            return text
        }
        guard !parts.isEmpty else { return nil }
        let joined = parts.joined(separator: "\n")
        return joined.isEmpty ? nil : joined
    }

    public var imageURLs: [URL] {
        (contentBlocks ?? []).compactMap(\.imageURL)
    }

    public var userInputRequest: UserInputRequest? {
        guard typedEventType == .requestUserInput, let payload else { return nil }
        return payload.decode(UserInputRequest.self)
    }

    public var capabilityOffer: CapabilityOffer? {
        guard typedEventType == .capabilityOffer, let payload else { return nil }
        return payload.decode(CapabilityOffer.self)
    }

    /// `requestId` on request/response pairs.
    public var requestId: String? { payload?["requestId"]?.stringValue }

    /// `offerId` on offer/response pairs.
    public var offerId: String? { payload?["offerId"]?.stringValue }

    /// Display name for a tool event, from the payload the Fast runtime persists.
    public var toolTitle: String {
        guard let payload else { return typedEventType?.shortName ?? eventType }
        let candidates = [
            payload["title"]?.stringValue,
            payload["mcpToolName"]?.stringValue,
            payload["toolName"]?.stringValue,
            payload["command"]?.stringValue,
            payload["kind"]?.stringValue,
        ]
        return candidates.compactMap { $0 }.first(where: { !$0.isEmpty }) ?? typedEventType?.shortName ?? eventType
    }

    public var toolStatus: String? { payload?["status"]?.stringValue }
    public var toolOutput: String? { payload?["output"]?.stringValue }
}

extension MessageEventType {
    var shortName: String {
        switch self {
        case .toolCall: "Tool call"
        case .toolCallUpdate: "Tool update"
        case .toolResult: "Tool result"
        default: rawValue.replacingOccurrences(of: "roomote_runtime.", with: "")
        }
    }
}

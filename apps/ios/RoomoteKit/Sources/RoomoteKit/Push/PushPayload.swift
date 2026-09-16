import Foundation

public enum PushCategory: String, Sendable, CaseIterable {
    case userInput = "USER_INPUT"
    case capabilityOffer = "CAPABILITY_OFFER"
    case taskSettled = "TASK_SETTLED"
    case reply = "REPLY"
}

public enum PushAction: String, Sendable {
    case reply = "REPLY"
    case open = "OPEN"
    case approve = "APPROVE"
    case decline = "DECLINE"
}

/// The `data` object carried by every Roomote push notification.
public struct PushPayload: Sendable, Equatable {
    public var kind: String
    public var sessionId: String?
    public var fastConversationId: String?
    public var taskId: String?
    public var requestId: String?
    public var offerId: String?
    public var capability: String?
    public var url: URL?
    public var category: String?

    public init(
        kind: String,
        sessionId: String? = nil,
        fastConversationId: String? = nil,
        taskId: String? = nil,
        requestId: String? = nil,
        offerId: String? = nil,
        capability: String? = nil,
        url: URL? = nil,
        category: String? = nil
    ) {
        self.kind = kind
        self.sessionId = sessionId
        self.fastConversationId = fastConversationId
        self.taskId = taskId
        self.requestId = requestId
        self.offerId = offerId
        self.capability = capability
        self.url = url
        self.category = category
    }

    public init?(userInfo: [AnyHashable: Any]) {
        guard let data = userInfo["data"] as? [String: Any] else { return nil }
        let string: (String) -> String? = { key in
            guard let value = data[key] else { return nil }
            if let text = value as? String { return text.isEmpty ? nil : text }
            if let number = value as? NSNumber { return number.stringValue }
            return nil
        }
        kind = string("kind") ?? ""
        sessionId = string("sessionId")
        fastConversationId = string("fastConversationId")
        taskId = string("taskId")
        requestId = string("requestId")
        offerId = string("offerId")
        capability = string("capability")
        url = string("url").flatMap(URL.init(string:))
        category = (userInfo["aps"] as? [String: Any])?["category"] as? String
    }

    /// Session id usable with `/api/v1/sessions/:id` (either id is accepted).
    public var routingSessionId: String? { sessionId ?? fastConversationId }

    /// Where a tap should land: the explicit `url`, else derived from the ids.
    public var deepLink: DeepLink? {
        if let url, let link = DeepLink(url: url) { return link }
        if let id = routingSessionId { return .session(id: id) }
        if let taskId { return .task(id: taskId) }
        return nil
    }
}

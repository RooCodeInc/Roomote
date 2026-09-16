import Foundation

public struct QuestionOption: Codable, Sendable, Hashable, Identifiable {
    public var id: String?
    public var label: String
    public var description: String?

    public init(id: String? = nil, label: String, description: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
    }

    /// Value sent back in an answer: the option id when present, else the label.
    public var answerValue: String { id ?? label }

    enum CodingKeys: String, CodingKey { case id, label, description }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        description = try container.decodeIfPresent(String.self, forKey: .description)
    }
}

public struct Question: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var header: String
    public var question: String
    public var isOther: Bool
    public var isSecret: Bool
    public var multiple: Bool?
    public var options: [QuestionOption]?

    public init(
        id: String,
        header: String = "",
        question: String,
        isOther: Bool = false,
        isSecret: Bool = false,
        multiple: Bool? = nil,
        options: [QuestionOption]? = nil
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.isOther = isOther
        self.isSecret = isSecret
        self.multiple = multiple
        self.options = options
    }

    enum CodingKeys: String, CodingKey { case id, header, question, isOther, isSecret, multiple, options }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        header = try container.decodeIfPresent(String.self, forKey: .header) ?? ""
        question = try container.decodeIfPresent(String.self, forKey: .question) ?? ""
        isOther = try container.decodeIfPresent(Bool.self, forKey: .isOther) ?? false
        isSecret = try container.decodeIfPresent(Bool.self, forKey: .isSecret) ?? false
        multiple = try container.decodeIfPresent(Bool.self, forKey: .multiple)
        options = try container.decodeIfPresent([QuestionOption].self, forKey: .options)
    }

    public var hasOptions: Bool { !(options ?? []).isEmpty }
    public var allowsMultiple: Bool { multiple ?? false }
    public var allowsFreeText: Bool { !hasOptions || isOther }
}

/// `request_user_input` payload and the inbox `request` object share this shape.
public struct UserInputRequest: Codable, Sendable, Hashable, Identifiable {
    public var requestId: String
    public var status: String?
    public var questions: [Question]

    public var id: String { requestId }

    public init(requestId: String, status: String? = nil, questions: [Question]) {
        self.requestId = requestId
        self.status = status
        self.questions = questions
    }

    enum CodingKeys: String, CodingKey { case requestId, status, questions }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try container.decode(String.self, forKey: .requestId)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        questions = try container.decodeIfPresent([Question].self, forKey: .questions) ?? []
    }
}

/// `capability_offer` payload and the inbox `offer` object share this shape.
public struct CapabilityOffer: Codable, Sendable, Hashable, Identifiable {
    public var offerId: String
    public var capability: String
    public var message: String
    public var status: String?
    public var integrationIds: [String]?

    public var id: String { offerId }

    public init(offerId: String, capability: String, message: String, status: String? = nil, integrationIds: [String]? = nil) {
        self.offerId = offerId
        self.capability = capability
        self.message = message
        self.status = status
        self.integrationIds = integrationIds
    }

    enum CodingKeys: String, CodingKey { case offerId, capability, message, status, integrationIds }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        offerId = try container.decode(String.self, forKey: .offerId)
        capability = try container.decodeIfPresent(String.self, forKey: .capability) ?? ""
        message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
        status = try container.decodeIfPresent(String.self, forKey: .status)
        integrationIds = try container.decodeIfPresent([String].self, forKey: .integrationIds)
    }

    /// Human-readable capability name, e.g. `source_control` -> `Source control`.
    public var capabilityTitle: String {
        let words = capability.split(whereSeparator: { $0 == "_" || $0 == "-" }).map(String.init)
        guard let first = words.first else { return capability }
        return ([first.capitalized] + words.dropFirst()).joined(separator: " ")
    }
}

public enum InboxKind: String, Sendable {
    case userInput = "user_input"
    case capabilityOffer = "capability_offer"
}

public struct InboxItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: String
    public var sessionId: String?
    public var fastConversationId: String
    public var sessionTitle: String
    public var createdAt: Date
    public var request: UserInputRequest?
    public var offer: CapabilityOffer?

    public init(
        id: String,
        kind: String,
        sessionId: String?,
        fastConversationId: String,
        sessionTitle: String,
        createdAt: Date,
        request: UserInputRequest? = nil,
        offer: CapabilityOffer? = nil
    ) {
        self.id = id
        self.kind = kind
        self.sessionId = sessionId
        self.fastConversationId = fastConversationId
        self.sessionTitle = sessionTitle
        self.createdAt = createdAt
        self.request = request
        self.offer = offer
    }

    enum CodingKeys: String, CodingKey { case id, kind, sessionId, fastConversationId, sessionTitle, createdAt, request, offer }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        fastConversationId = try container.decodeIfPresent(String.self, forKey: .fastConversationId) ?? ""
        sessionTitle = try container.decodeIfPresent(String.self, forKey: .sessionTitle) ?? ""
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        request = try container.decodeIfPresent(UserInputRequest.self, forKey: .request)
        offer = try container.decodeIfPresent(CapabilityOffer.self, forKey: .offer)
    }

    public var typedKind: InboxKind? { InboxKind(rawValue: kind) }

    /// Id usable with `/api/v1/sessions/:id`; the contract accepts either id.
    public var routingSessionId: String { sessionId ?? fastConversationId }
}

public struct InboxResponse: Codable, Sendable {
    public var items: [InboxItem]
    public init(items: [InboxItem]) { self.items = items }
}

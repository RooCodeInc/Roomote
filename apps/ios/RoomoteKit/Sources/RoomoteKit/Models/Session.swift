import Foundation

public struct LinkedTask: Codable, Sendable, Hashable, Identifiable {
    public var taskId: String
    public var title: String?
    public var state: String?
    public var repositoryName: String?

    public var id: String { taskId }

    public init(taskId: String, title: String? = nil, state: String? = nil, repositoryName: String? = nil) {
        self.taskId = taskId
        self.title = title
        self.state = state
        self.repositoryName = repositoryName
    }
}

public struct PullRequestRef: Codable, Sendable, Hashable, Identifiable {
    public var url: String
    public var number: Int?
    public var repository: String?
    public var status: String?

    public var id: String { url }

    public init(url: String, number: Int? = nil, repository: String? = nil, status: String? = nil) {
        self.url = url
        self.number = number
        self.repository = repository
        self.status = status
    }

    enum CodingKeys: String, CodingKey { case url, number, repository, status }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        url = try container.decode(String.self, forKey: .url)
        number = try container.decodeIfPresent(Int.self, forKey: .number)
            ?? container.decodeIfPresent(Double.self, forKey: .number).map(Int.init)
        repository = try container.decodeIfPresent(String.self, forKey: .repository)
        status = try container.decodeIfPresent(String.self, forKey: .status)
    }

    public var title: String {
        if let repository, let number { return "\(repository)#\(number)" }
        if let number { return "#\(number)" }
        return url
    }
}

public struct Session: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var fastConversationId: String?
    public var title: String?
    public var ownerName: String?
    public var ownerImageUrl: String?
    public var sourceSurface: String
    public var sourceTrigger: String?
    public var activityAt: Date
    public var createdAt: Date
    public var cachedStatus: String?
    public var respondingUntil: Date?
    public var archivedAt: Date?
    public var unread: Bool
    public var linkedTasks: [LinkedTask]
    public var pullRequests: [PullRequestRef]

    public init(
        id: String,
        fastConversationId: String? = nil,
        title: String? = nil,
        ownerName: String? = nil,
        ownerImageUrl: String? = nil,
        sourceSurface: String = "web",
        sourceTrigger: String? = nil,
        activityAt: Date = Date(),
        createdAt: Date = Date(),
        cachedStatus: String? = nil,
        respondingUntil: Date? = nil,
        archivedAt: Date? = nil,
        unread: Bool = false,
        linkedTasks: [LinkedTask] = [],
        pullRequests: [PullRequestRef] = []
    ) {
        self.id = id
        self.fastConversationId = fastConversationId
        self.title = title
        self.ownerName = ownerName
        self.ownerImageUrl = ownerImageUrl
        self.sourceSurface = sourceSurface
        self.sourceTrigger = sourceTrigger
        self.activityAt = activityAt
        self.createdAt = createdAt
        self.cachedStatus = cachedStatus
        self.respondingUntil = respondingUntil
        self.archivedAt = archivedAt
        self.unread = unread
        self.linkedTasks = linkedTasks
        self.pullRequests = pullRequests
    }

    enum CodingKeys: String, CodingKey {
        case id, fastConversationId, title, ownerName, ownerImageUrl, sourceSurface, sourceTrigger
        case activityAt, createdAt, cachedStatus, respondingUntil, archivedAt, unread, linkedTasks, pullRequests
    }

    private enum WireKeys: String, CodingKey {
        case tasks
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        fastConversationId = try container.decodeIfPresent(String.self, forKey: .fastConversationId)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        ownerName = try container.decodeIfPresent(String.self, forKey: .ownerName)
        ownerImageUrl = try container.decodeIfPresent(String.self, forKey: .ownerImageUrl)
        sourceSurface = try container.decodeIfPresent(String.self, forKey: .sourceSurface) ?? ""
        sourceTrigger = try container.decodeIfPresent(String.self, forKey: .sourceTrigger)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        activityAt = try container.decodeIfPresent(Date.self, forKey: .activityAt) ?? createdAt
        cachedStatus = try container.decodeIfPresent(String.self, forKey: .cachedStatus)
        respondingUntil = try container.decodeIfPresent(Date.self, forKey: .respondingUntil)
        archivedAt = try container.decodeIfPresent(Date.self, forKey: .archivedAt)
        unread = try container.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        // The API serializes the hydrated Session row, whose task list is `tasks`.
        let wire = try decoder.container(keyedBy: WireKeys.self)
        linkedTasks = try wire.decodeIfPresent([LinkedTask].self, forKey: .tasks)
            ?? container.decodeIfPresent([LinkedTask].self, forKey: .linkedTasks)
            ?? []
        pullRequests = try container.decodeIfPresent([PullRequestRef].self, forKey: .pullRequests) ?? []
    }

    public var displayTitle: String {
        if let title, !title.trimmingCharacters(in: .whitespaces).isEmpty { return title }
        return "Untitled session"
    }

    public func isResponding(at now: Date = Date()) -> Bool {
        guard let respondingUntil else { return false }
        return respondingUntil > now
    }
}

public struct SessionsPage: Codable, Sendable {
    public var sessions: [Session]
    public var nextCursor: String?

    public init(sessions: [Session], nextCursor: String? = nil) {
        self.sessions = sessions
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey { case sessions, nextCursor }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try container.decodeIfPresent([Session].self, forKey: .sessions) ?? []
        nextCursor = try container.decodeIfPresent(JSONValue.self, forKey: .nextCursor).flatMap(Cursor.string(from:))
    }
}

public struct SessionMessages: Codable, Sendable {
    public var sessionId: String
    public var title: String?
    public var model: String?
    public var messages: [Message]
    public var hasOlderMessages: Bool

    public init(sessionId: String, title: String? = nil, model: String? = nil, messages: [Message], hasOlderMessages: Bool = false) {
        self.sessionId = sessionId
        self.title = title
        self.model = model
        self.messages = messages
        self.hasOlderMessages = hasOlderMessages
    }

    enum CodingKeys: String, CodingKey { case sessionId, title, model, messages, hasOlderMessages }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        messages = try container.decodeIfPresent([Message].self, forKey: .messages) ?? []
        hasOlderMessages = try container.decodeIfPresent(Bool.self, forKey: .hasOlderMessages) ?? false
    }
}

public struct CreatedSession: Codable, Sendable {
    public var sessionId: String
    public var fastConversationId: String?

    public init(sessionId: String, fastConversationId: String? = nil) {
        self.sessionId = sessionId
        self.fastConversationId = fastConversationId
    }
}

/// Cursors arrive as strings, numbers, or objects; they go back out as strings.
public enum Cursor {
    public static func string(from value: JSONValue) -> String? {
        switch value {
        case .null: nil
        case .string(let string): string
        case .number(let number): number == number.rounded() ? String(Int64(number)) : String(number)
        case .bool(let bool): String(bool)
        case .array, .object: value.jsonString
        }
    }
}

import Foundation

public struct TaskPullRequest: Codable, Sendable, Hashable, Identifiable {
    public var prUrl: String
    public var prNumber: Int?
    public var repository: String?
    public var status: String?

    public var id: String { prUrl }

    public init(prUrl: String, prNumber: Int? = nil, repository: String? = nil, status: String? = nil) {
        self.prUrl = prUrl
        self.prNumber = prNumber
        self.repository = repository
        self.status = status
    }

    enum CodingKeys: String, CodingKey { case prUrl, prNumber, repository, status }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        prUrl = try container.decode(String.self, forKey: .prUrl)
        prNumber = try container.decodeIfPresent(Int.self, forKey: .prNumber)
            ?? container.decodeIfPresent(Double.self, forKey: .prNumber).map(Int.init)
        repository = try container.decodeIfPresent(String.self, forKey: .repository)
        status = try container.decodeIfPresent(String.self, forKey: .status)
    }

    public var title: String {
        if let repository, let prNumber { return "\(repository)#\(prNumber)" }
        if let prNumber { return "#\(prNumber)" }
        return prUrl
    }
}

public struct TaskRun: Codable, Sendable, Hashable, Identifiable {
    public var id: Int
    public var status: String
    public var phase: String?

    public init(id: Int, status: String, phase: String? = nil) {
        self.id = id
        self.status = status
        self.phase = phase
    }

    enum CodingKeys: String, CodingKey { case id, status, phase }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(Int.self, forKey: .id)
            ?? container.decodeIfPresent(Double.self, forKey: .id).map(Int.init)
            ?? container.decodeIfPresent(String.self, forKey: .id).flatMap(Int.init) ?? 0
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? ""
        phase = try container.decodeIfPresent(String.self, forKey: .phase)
    }
}

/// Well-known task states; unknown states decode as strings and fall to `.other`.
public enum TaskState: String, Sendable {
    case pending, queued, active, running, completed, failed, cancelled, canceled

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .canceled: true
        default: false
        }
    }
}

/// Named `RoomoteTask` because `Task` collides with Swift concurrency.
public struct RoomoteTask: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String?
    public var workflow: String
    public var state: String
    public var repositoryName: String?
    public var activityAt: Date
    public var createdAt: Date
    public var model: String?
    public var pullRequests: [TaskPullRequest]?
    public var latestRun: TaskRun?
    public var artifacts: [Artifact]?

    public init(
        id: String,
        title: String? = nil,
        workflow: String = "",
        state: String,
        repositoryName: String? = nil,
        activityAt: Date = Date(),
        createdAt: Date = Date(),
        model: String? = nil,
        pullRequests: [TaskPullRequest]? = nil,
        latestRun: TaskRun? = nil,
        artifacts: [Artifact]? = nil
    ) {
        self.id = id
        self.title = title
        self.workflow = workflow
        self.state = state
        self.repositoryName = repositoryName
        self.activityAt = activityAt
        self.createdAt = createdAt
        self.model = model
        self.pullRequests = pullRequests
        self.latestRun = latestRun
        self.artifacts = artifacts
    }

    enum CodingKeys: String, CodingKey {
        case id, title, workflow, state, repositoryName, activityAt, createdAt, model, pullRequests, latestRun, artifacts
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        workflow = try container.decodeIfPresent(String.self, forKey: .workflow) ?? ""
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? ""
        repositoryName = try container.decodeIfPresent(String.self, forKey: .repositoryName)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        activityAt = try container.decodeIfPresent(Date.self, forKey: .activityAt) ?? createdAt
        model = try container.decodeIfPresent(String.self, forKey: .model)
        pullRequests = try container.decodeIfPresent([TaskPullRequest].self, forKey: .pullRequests)
        latestRun = try container.decodeIfPresent(TaskRun.self, forKey: .latestRun)
        artifacts = try container.decodeIfPresent([Artifact].self, forKey: .artifacts)
    }

    public var typedState: TaskState? { TaskState(rawValue: state.lowercased()) }

    public var displayTitle: String {
        if let title, !title.trimmingCharacters(in: .whitespaces).isEmpty { return title }
        return workflow.isEmpty ? "Untitled task" : workflow
    }
}

public struct TasksPage: Codable, Sendable {
    public var tasks: [RoomoteTask]
    public var nextCursor: String?

    public init(tasks: [RoomoteTask], nextCursor: String? = nil) {
        self.tasks = tasks
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey { case tasks, nextCursor }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = try container.decodeIfPresent([RoomoteTask].self, forKey: .tasks) ?? []
        nextCursor = try container.decodeIfPresent(JSONValue.self, forKey: .nextCursor).flatMap(Cursor.string(from:))
    }
}

/// Partial task update carried by the `task` SSE event on `/tasks/:id/stream`.
public struct TaskStreamUpdate: Codable, Sendable {
    public var state: String?
    public var latestRun: TaskRun?

    public init(state: String? = nil, latestRun: TaskRun? = nil) {
        self.state = state
        self.latestRun = latestRun
    }
}

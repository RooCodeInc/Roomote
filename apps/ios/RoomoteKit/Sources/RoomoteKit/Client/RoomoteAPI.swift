import Foundation

public struct AnswerValue: Codable, Sendable, Hashable {
    public var answers: [String]
    public init(answers: [String]) { self.answers = answers }
}

public typealias Answers = [String: AnswerValue]

public enum SessionsScope: String, Sendable, CaseIterable {
    case all, tasks, reviews, automations
}

// MARK: - Auth

extension RoomoteClient {
    private struct EmailSignIn: Encodable { var email: String; var password: String }
    private struct ExchangeBody: Encodable { var code: String }
    private struct ExchangeResponse: Decodable { var token: String }

    /// Native email/password sign-in; returns the `set-auth-token` header value.
    public func signIn(email: String, password: String) async throws -> String {
        let (_, response) = try await send(
            .post,
            path: "/api/auth/sign-in/email",
            body: EmailSignIn(email: email, password: password),
            authenticated: false
        )
        guard let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty else {
            throw RoomoteError.missingHeader("set-auth-token")
        }
        setToken(token)
        return token
    }

    /// Exchanges the one-time browser handoff code for a session token.
    public func exchangeAuthCode(_ code: String) async throws -> String {
        let (data, _) = try await send(.post, path: "/api/v1/auth/exchange", body: ExchangeBody(code: code), authenticated: false)
        let decoded: ExchangeResponse
        do {
            decoded = try JSONCoding.decoder.decode(ExchangeResponse.self, from: data)
        } catch {
            throw RoomoteError.decoding(String(describing: error))
        }
        setToken(decoded.token)
        return decoded.token
    }

    public func signOut() async throws {
        try await send(.post, path: "/api/auth/sign-out", body: nil as EmptyBody?)
    }

    public nonisolated func mobileHandoffURL(redirect: String = "roomote://auth") throws -> URL {
        try url(for: "/api/auth/mobile-handoff", query: [URLQueryItem(name: "redirect", value: redirect)])
    }
}

// MARK: - Me / Inbox

extension RoomoteClient {
    public func me() async throws -> Me {
        try await get("/api/v1/me")
    }

    public func inbox() async throws -> [InboxItem] {
        let response: InboxResponse = try await get("/api/v1/inbox")
        return response.items
    }
}

// MARK: - Sessions

extension RoomoteClient {
    private struct CreateSessionBody: Encodable {
        var text: String
        var model: String?
        var images: [String]?
    }

    private struct ReplyBody: Encodable {
        var text: String
        var clientMessageId: String?
        var images: [String]?
    }

    private struct AnswerBody: Encodable {
        var requestId: String
        var answers: Answers
        var resolution: String?
    }

    private struct OfferBody: Encodable {
        var offerId: String
        var capability: String
        var resolution: String
        var selectedIds: [String]?
    }

    public func sessions(
        scope: SessionsScope = .all,
        status: String? = nil,
        query: String? = nil,
        before: String? = nil,
        limit: Int = 50
    ) async throws -> SessionsPage {
        var items = [URLQueryItem(name: "scope", value: scope.rawValue), URLQueryItem(name: "limit", value: String(limit))]
        if let status, !status.isEmpty { items.append(URLQueryItem(name: "status", value: status)) }
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let before, !before.isEmpty { items.append(URLQueryItem(name: "before", value: before)) }
        return try await get("/api/v1/sessions", query: items)
    }

    public func session(id: String) async throws -> Session {
        try await get("/api/v1/sessions/\(Self.escape(id))")
    }

    public func sessionMessages(id: String) async throws -> SessionMessages {
        try await get("/api/v1/sessions/\(Self.escape(id))/messages")
    }

    public func createSession(text: String, model: String? = nil, images: [String]? = nil) async throws -> CreatedSession {
        try await post("/api/v1/sessions", body: CreateSessionBody(text: text, model: model, images: images))
    }

    public func reply(sessionID: String, text: String, clientMessageId: String? = nil, images: [String]? = nil) async throws {
        let _: SuccessResponse = try await post(
            "/api/v1/sessions/\(Self.escape(sessionID))/reply",
            body: ReplyBody(text: text, clientMessageId: clientMessageId, images: images)
        )
    }

    public func answer(sessionID: String, requestId: String, answers: Answers, resolution: String? = nil) async throws {
        let _: SuccessResponse = try await post(
            "/api/v1/sessions/\(Self.escape(sessionID))/answer",
            body: AnswerBody(requestId: requestId, answers: answers, resolution: resolution)
        )
    }

    public func respondToCapabilityOffer(
        sessionID: String,
        offerId: String,
        capability: String,
        approve: Bool,
        selectedIds: [String]? = nil
    ) async throws {
        let _: SuccessResponse = try await post(
            "/api/v1/sessions/\(Self.escape(sessionID))/capability-offer",
            body: OfferBody(offerId: offerId, capability: capability, resolution: approve ? "completed" : "dismissed", selectedIds: selectedIds)
        )
    }

    public func markRead(sessionID: String) async throws {
        let _: SuccessResponse = try await post("/api/v1/sessions/\(Self.escape(sessionID))/read")
    }

    /// Request for the Session SSE stream (existing web route).
    public func sessionStreamRequest(fastConversationId: String, since: Double?) throws -> URLRequest {
        var query: [URLQueryItem] = []
        if let since { query.append(URLQueryItem(name: "since", value: String(Int64(since)))) }
        var request = try authorizedRequest(path: "/api/sessions/\(Self.escape(fastConversationId))/stream", query: query)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3_900
        return request
    }
}

// MARK: - Tasks

extension RoomoteClient {
    private struct SteerBody: Encodable { var prompt: String; var images: [String]? }
    private struct TaskAnswerBody: Encodable { var requestId: String; var answers: Answers }
    private struct CancelBody: Encodable { var terminate: Bool? }

    public func tasks(limit: Int = 50, cursor: String? = nil) async throws -> TasksPage {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor, !cursor.isEmpty { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("/api/v1/tasks", query: items)
    }

    public func task(id: String) async throws -> RoomoteTask {
        try await get("/api/v1/tasks/\(Self.escape(id))")
    }

    public func transcript(taskID: String, cursor: String? = nil) async throws -> TranscriptPage {
        var items: [URLQueryItem] = []
        if let cursor, !cursor.isEmpty { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("/api/v1/tasks/\(Self.escape(taskID))/transcript", query: items)
    }

    public func steer(taskID: String, prompt: String, images: [String]? = nil) async throws {
        let _: SuccessResponse = try await post("/api/v1/tasks/\(Self.escape(taskID))/steer", body: SteerBody(prompt: prompt, images: images))
    }

    public func answerTask(taskID: String, requestId: String, answers: Answers) async throws {
        let _: SuccessResponse = try await post(
            "/api/v1/tasks/\(Self.escape(taskID))/answer",
            body: TaskAnswerBody(requestId: requestId, answers: answers)
        )
    }

    public func cancelTask(taskID: String, terminate: Bool? = nil) async throws {
        let _: SuccessResponse = try await post("/api/v1/tasks/\(Self.escape(taskID))/cancel", body: CancelBody(terminate: terminate))
    }

    public func taskStreamRequest(taskID: String, since: Double?) throws -> URLRequest {
        var query: [URLQueryItem] = []
        if let since { query.append(URLQueryItem(name: "since", value: String(Int64(since)))) }
        var request = try authorizedRequest(path: "/api/v1/tasks/\(Self.escape(taskID))/stream", query: query)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3_900
        return request
    }
}

// MARK: - Devices

extension RoomoteClient {
    public func registerDevice(token: String, registration: DeviceRegistration) async throws {
        let _: SuccessResponse = try await put("/api/v1/devices/\(Self.escape(token))", body: registration)
    }

    public func unregisterDevice(token: String) async throws {
        let _: SuccessResponse = try await delete("/api/v1/devices/\(Self.escape(token))")
    }
}

extension RoomoteClient {
    nonisolated static func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? component
    }
}

import Foundation

extension Notification.Name {
    /// Posted when a request is rejected with 401 and the in-memory token is dropped.
    public static let roomoteSignedOut = Notification.Name("dev.roomote.signedOut")
}

public enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", delete = "DELETE"
}

/// JSON client for the deployment's `/api/v1` surface.
public actor RoomoteClient {
    public nonisolated let baseURL: URL
    private var token: String?
    private let session: URLSession
    private let onUnauthorized: (@Sendable () -> Void)?

    public init(
        baseURL: URL,
        token: String?,
        session: URLSession = .shared,
        onUnauthorized: (@Sendable () -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.onUnauthorized = onUnauthorized
    }

    public var currentToken: String? { token }
    public var isAuthenticated: Bool { token != nil }

    public func setToken(_ token: String?) {
        self.token = token
    }

    // MARK: Typed helpers

    public func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, _) = try await send(.get, path: path, query: query, body: nil as EmptyBody?)
        return try decode(T.self, from: data)
    }

    public func post<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, body: B?) async throws -> T {
        let (data, _) = try await send(.post, path: path, body: body)
        return try decode(T.self, from: data)
    }

    public func post<T: Decodable & Sendable>(_ path: String) async throws -> T {
        try await post(path, body: nil as EmptyBody?)
    }

    public func put<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, body: B?) async throws -> T {
        let (data, _) = try await send(.put, path: path, body: body)
        return try decode(T.self, from: data)
    }

    public func delete<T: Decodable & Sendable>(_ path: String) async throws -> T {
        let (data, _) = try await send(.delete, path: path, body: nil as EmptyBody?)
        return try decode(T.self, from: data)
    }

    // MARK: Raw requests

    public nonisolated func url(for path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw RoomoteError.invalidURL
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + (path.hasPrefix("/") ? path : "/" + path)
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw RoomoteError.invalidURL }
        return url
    }

    /// Builds a bearer-authenticated request without sending it (used by SSE).
    public func authorizedRequest(_ method: HTTPMethod = .get, path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        var request = URLRequest(url: try url(for: path, query: query))
        request.httpMethod = method.rawValue
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    @discardableResult
    public func send<B: Encodable & Sendable>(
        _ method: HTTPMethod,
        path: String,
        query: [URLQueryItem] = [],
        body: B?,
        authenticated: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: try url(for: path, query: query))
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            guard let token else { throw RoomoteError.missingToken }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONCoding.encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw RoomoteError.cancelled
        } catch let error as URLError where error.code == .cancelled {
            throw RoomoteError.cancelled
        } catch {
            throw RoomoteError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw RoomoteError.transport("Not an HTTP response.")
        }
        if http.statusCode == 401, authenticated {
            token = nil
            onUnauthorized?()
            NotificationCenter.default.post(name: .roomoteSignedOut, object: nil)
            throw RoomoteError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            throw RoomoteError.http(status: http.statusCode, message: Self.errorMessage(from: data, status: http.statusCode))
        }
        return (data, http)
    }

    private nonisolated func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        if data.isEmpty, let empty = SuccessResponse() as? T {
            return empty
        }
        do {
            return try JSONCoding.decoder.decode(type, from: data)
        } catch {
            throw RoomoteError.decoding(String(describing: error))
        }
    }

    private nonisolated static func errorMessage(from data: Data, status: Int) -> String {
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data),
           let message = envelope.error ?? envelope.message, !message.isEmpty {
            return message
        }
        if let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty, text.count < 200, !text.hasPrefix("<") {
            return text
        }
        return HTTPURLResponse.localizedString(forStatusCode: status).capitalized
    }
}

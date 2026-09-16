import Foundation

public enum RoomoteError: Error, Sendable, LocalizedError {
    case invalidURL
    case missingToken
    case unauthorized
    case http(status: Int, message: String)
    case decoding(String)
    case transport(String)
    case missingHeader(String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .invalidURL: "The deployment URL is not valid."
        case .missingToken: "You are signed out."
        case .unauthorized: "Your session has expired. Sign in again."
        case .http(let status, let message): message.isEmpty ? "Request failed (\(status))." : message
        case .decoding(let detail): "The server sent an unexpected response. \(detail)"
        case .transport(let detail): detail
        case .missingHeader(let name): "The server did not return the \(name) header."
        case .cancelled: "Cancelled."
        }
    }

    public var isUnauthorized: Bool {
        if case .unauthorized = self { return true }
        return false
    }
}

struct ErrorEnvelope: Decodable {
    var error: String?
    var message: String?
}

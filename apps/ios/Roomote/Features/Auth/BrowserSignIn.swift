import AuthenticationServices
import UIKit
import RoomoteKit

/// Runs the `/api/auth/mobile-handoff` flow in ASWebAuthenticationSession.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum Failure: Error, LocalizedError {
        case cancelled
        case missingCode

        var errorDescription: String? {
            switch self {
            case .cancelled: "Sign in was cancelled."
            case .missingCode: "The browser did not return a sign-in code."
            }
        }
    }

    private var session: ASWebAuthenticationSession?

    /// Returns the one-time code from `roomote://auth?code=...`.
    func requestCode(handoffURL: URL) async throws -> String {
        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: handoffURL, callbackURLScheme: DeepLink.scheme) { url, error in
                if let error {
                    if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                        continuation.resume(throwing: Failure.cancelled)
                    } else {
                        continuation.resume(throwing: error)
                    }
                    return
                }
                guard let url else {
                    continuation.resume(throwing: Failure.missingCode)
                    return
                }
                continuation.resume(returning: url)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(throwing: Failure.cancelled)
            }
        }
        session = nil
        guard case .auth(let code)? = DeepLink(url: callbackURL), let code, !code.isEmpty else {
            throw Failure.missingCode
        }
        return code
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}

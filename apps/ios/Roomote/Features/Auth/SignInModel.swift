import Foundation
import Observation
import RoomoteKit

@MainActor
@Observable
final class SignInModel {
    var email = ""
    var password = ""
    var hostInput = ""
    var showAdvanced = false
    var isBusy = false
    var errorMessage: String?

    private let app: AppModel
    private let browserSignIn = BrowserSignIn()

    init(app: AppModel) {
        self.app = app
        hostInput = app.baseURL.absoluteString
    }

    var displayHost: String { app.deploymentHost }

    var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty && !isBusy
    }

    /// Applies the Advanced host field. Returns false when the URL is invalid.
    @discardableResult
    func applyHost() -> Bool {
        var raw = hostInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty {
            app.setDeploymentURL(nil)
            hostInput = app.baseURL.absoluteString
            return true
        }
        if !raw.contains("://") { raw = "https://" + raw }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else {
            errorMessage = "Enter a valid deployment URL, e.g. https://roo.example.com"
            return false
        }
        app.setDeploymentURL(url)
        hostInput = app.baseURL.absoluteString
        return true
    }

    func signInWithPassword() async {
        guard applyHost(), canSubmit else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let token = try await app.client.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
            password = ""
            app.completeSignIn(token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signInWithBrowser() async {
        guard applyHost() else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let handoff = try app.client.mobileHandoffURL()
            let code = try await browserSignIn.requestCode(handoffURL: handoff)
            let token = try await app.client.exchangeAuthCode(code)
            app.completeSignIn(token: token)
        } catch BrowserSignIn.Failure.cancelled {
            // User dismissed the sheet.
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

import Foundation
import Observation
import RoomoteKit

/// Process-wide state: configuration, credentials, the API client, and routing.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let configuration: AppConfiguration
    let sessionStore: SessionStore
    let router = Router()
    private(set) var notifications: NotificationManager!

    private(set) var baseURL: URL
    private(set) var client: RoomoteClient
    private(set) var isSignedIn: Bool
    private(set) var me: Me?
    var globalError: String?

    /// Bumped whenever a push arrives in the foreground so lists can refresh.
    private(set) var refreshToken = 0

    /// Items waiting on the user; shown as a badge on the top bar menu button.
    private(set) var inboxCount = 0

    private init() {
        let configuration = AppConfiguration.load()
        let store = SessionStore(configuration: configuration)
        let token = store.token()
        let baseURL = store.deploymentURLOverride() ?? configuration.deploymentURL
        self.configuration = configuration
        self.sessionStore = store
        self.baseURL = baseURL
        self.client = AppModel.makeClient(baseURL: baseURL, token: token)
        self.isSignedIn = token != nil
        self.notifications = NotificationManager(app: self)
        if token != nil {
            Task { await self.loadMe() }
        }
        #if DEBUG
        // Simulator convenience: `SIMCTL_CHILD_ROOMOTE_DEV_AUTH_CODE=<code> xcrun simctl launch ...`
        // exchanges a mobile-handoff code without the "Open in Roomote?" prompt.
        if token == nil, let code = ProcessInfo.processInfo.environment["ROOMOTE_DEV_AUTH_CODE"], !code.isEmpty {
            Task { await self.exchangeDevAuthCode(code) }
        }
        #endif
    }

    #if DEBUG
    private func exchangeDevAuthCode(_ code: String) async {
        do {
            let token = try await client.exchangeAuthCode(code)
            completeSignIn(token: token)
        } catch {
            globalError = error.localizedDescription
        }
    }
    #endif

    private static func makeClient(baseURL: URL, token: String?) -> RoomoteClient {
        RoomoteClient(baseURL: baseURL, token: token, onUnauthorized: {
            Task { @MainActor in AppModel.shared.handleUnauthorized() }
        })
    }

    // MARK: Deployment

    var deploymentHost: String {
        baseURL.host ?? baseURL.absoluteString
    }

    var usesDeploymentOverride: Bool {
        sessionStore.deploymentURLOverride() != nil
    }

    /// Changes the deployment URL (only while signed out).
    func setDeploymentURL(_ url: URL?) {
        let resolved = url ?? configuration.deploymentURL
        sessionStore.setDeploymentURLOverride(url == configuration.deploymentURL ? nil : url)
        baseURL = resolved
        client = AppModel.makeClient(baseURL: resolved, token: nil)
    }

    /// Web app URL for a path such as `/automations` or `/task/<id>`.
    func webURL(path: String) -> URL? {
        let base = me.flatMap { URL(string: $0.deployment.appUrl) } ?? baseURL
        return URL(string: path, relativeTo: base)?.absoluteURL
    }

    func refreshInboxCount() async {
        guard isSignedIn else { inboxCount = 0; return }
        if let items = try? await client.inbox() { inboxCount = items.count }
    }

    func setInboxCount(_ count: Int) {
        inboxCount = count
    }

    // MARK: Auth

    func completeSignIn(token: String) {
        sessionStore.setToken(token)
        client = AppModel.makeClient(baseURL: baseURL, token: token)
        isSignedIn = true
        globalError = nil
        Task {
            await loadMe()
            await notifications.requestAuthorizationAndRegister()
        }
        router.flushPendingLink()
    }

    func signOut() async {
        await notifications.unregisterDevice()
        try? await client.signOut()
        clearLocalSession()
    }

    func handleUnauthorized() {
        guard isSignedIn else { return }
        clearLocalSession()
        globalError = RoomoteError.unauthorized.localizedDescription
    }

    private func clearLocalSession() {
        sessionStore.clear()
        me = nil
        inboxCount = 0
        isSignedIn = false
        client = AppModel.makeClient(baseURL: baseURL, token: nil)
        router.reset()
    }

    func loadMe() async {
        do {
            me = try await client.me()
        } catch let error as RoomoteError where error.isUnauthorized {
            // handleUnauthorized already ran through the client callback.
        } catch {
            // Non-fatal; the UI degrades to "Signed in".
        }
    }

    // MARK: Links

    func handle(url: URL) {
        guard let link = DeepLink(url: url) else { return }
        switch link {
        case .auth(let code):
            guard let code, !isSignedIn else { return }
            Task {
                do {
                    let token = try await client.exchangeAuthCode(code)
                    completeSignIn(token: token)
                } catch {
                    globalError = error.localizedDescription
                }
            }
        case .session, .task:
            if isSignedIn {
                router.open(link)
            } else {
                router.pendingLink = link
            }
        }
    }

    func noteForegroundPush() {
        refreshToken += 1
    }

    // MARK: Notification actions

    func handleNotificationAction(_ action: String, text: String?, payload: PushPayload?) async {
        guard let payload else { return }
        switch PushAction(rawValue: action) {
        case .approve, .decline:
            guard let sessionID = payload.routingSessionId, let offerId = payload.offerId else { return }
            try? await client.respondToCapabilityOffer(
                sessionID: sessionID,
                offerId: offerId,
                capability: payload.capability ?? "",
                approve: action == PushAction.approve.rawValue
            )
        case .reply:
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                  let sessionID = payload.routingSessionId else { return }
            await replyFromNotification(sessionID: sessionID, requestId: payload.requestId, text: text)
        case .open, .none:
            if let link = payload.deepLink {
                handle(url: link.url ?? URL(string: "roomote://")!)
            }
        }
    }

    /// Free text from the notification answers the first question of the
    /// pending request when we can still find it, else it becomes a reply.
    private func replyFromNotification(sessionID: String, requestId: String?, text: String) async {
        if let requestId {
            let items = (try? await client.inbox()) ?? []
            if let item = items.first(where: { $0.request?.requestId == requestId }),
               let request = item.request,
               let question = request.questions.first {
                var answers: Answers = [question.id: AnswerValue(answers: [text])]
                // Every question must be answered; skip the rest with the same text
                // only when there is exactly one, otherwise fall back to a reply.
                if request.questions.count == 1 {
                    if (try? await client.answer(sessionID: sessionID, requestId: requestId, answers: answers)) != nil {
                        return
                    }
                }
                answers.removeAll()
            }
        }
        try? await client.reply(sessionID: sessionID, text: text, clientMessageId: UUID().uuidString)
    }
}

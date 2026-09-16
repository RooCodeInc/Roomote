import SwiftUI
import RoomoteKit

/// Composer landing page: starts a new Session.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var text = ""
    @State private var isCreating = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 8) {
                Text("What should Roomote work on?")
                    .font(RoomoteTheme.font(24, weight: .medium))
                    .foregroundStyle(RoomoteTheme.foreground)
                    .multilineTextAlignment(.center)
                Text("Start a Session; Roomote delegates coding work to sandboxed tasks.")
                    .font(RoomoteTheme.font(14))
                    .foregroundStyle(RoomoteTheme.mutedForeground)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 24)
            Spacer()
            if let error {
                InlineErrorBanner(message: error) { self.error = nil }
            }
            RoomoteComposer(placeholder: "Message agent", text: $text, isSending: isCreating) {
                Task { await create() }
            }
        }
        .background(RoomoteTheme.background)
        .scrollDismissesKeyboard(.interactively)
    }

    private func create() async {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isCreating else { return }
        isCreating = true
        error = nil
        defer { isCreating = false }
        do {
            let created = try await app.client.createSession(text: prompt)
            text = ""
            router.screen = .sessions
            router.path = [.session(id: created.sessionId)]
        } catch {
            self.error = error.localizedDescription
        }
    }
}

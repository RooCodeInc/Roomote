import SwiftUI
import RoomoteKit

/// 48pt bar above every root screen: menu, logo, new session, search, avatar.
struct TopBar: View {
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 2) {
            GhostIconButton(RoomoteIcon.menu, label: "Menu") {
                router.drawerOpen = true
            }
            .overlay(alignment: .topTrailing) {
                if app.inboxCount > 0 {
                    Text(app.inboxCount > 99 ? "99+" : String(app.inboxCount))
                        .font(RoomoteTheme.font(10, weight: .semibold))
                        .foregroundStyle(RoomoteTheme.warningForeground)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(RoomoteTheme.accent, in: Capsule())
                        .offset(x: -2, y: 4)
                        .accessibilityLabel("\(app.inboxCount) inbox items")
                }
            }
            Image("RLogo")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 28, height: 28)
                .foregroundStyle(RoomoteTheme.foreground)
                .padding(.horizontal, 4)
                .accessibilityLabel("Roomote")
            GhostIconButton(RoomoteIcon.plus, label: "New session", tint: RoomoteTheme.mutedForeground) {
                router.show(.home)
            }
            Spacer(minLength: 0)
            GhostIconButton(RoomoteIcon.search, label: "Search", tint: RoomoteTheme.mutedForeground) {
                router.sessionsSearchRequested = true
                router.show(.sessions)
            }
            Button {
                router.show(.settings)
            } label: {
                Avatar(name: app.me?.user.displayName, imageURL: app.me?.user.imageUrl, size: 32)
            }
            .buttonStyle(.plain)
            .padding(.leading, 6)
            .accessibilityLabel("Account")
        }
        .padding(.horizontal, 8)
        .frame(height: 48)
        .background(RoomoteTheme.card)
    }
}

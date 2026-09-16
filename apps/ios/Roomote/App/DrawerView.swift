import SwiftUI
import RoomoteKit

/// Left navigation drawer: primary destinations plus recent sessions.
struct DrawerView: View {
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app
    @State private var recent = SessionsListModel()
    @State private var safariURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer()
                GhostIconButton(RoomoteIcon.close, label: "Close menu") { router.drawerOpen = false }
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)

            VStack(alignment: .leading, spacing: 2) {
                DrawerItem(title: "New Session", icon: RoomoteIcon.plus) { router.show(.home) }
                DrawerItem(title: "Home", icon: RoomoteIcon.home, isCurrent: isRoot(.home)) { router.show(.home) }
                DrawerItem(title: "Sessions", icon: RoomoteIcon.sessions, isCurrent: isRoot(.sessions)) { router.show(.sessions) }
                DrawerItem(title: "Inbox", icon: RoomoteIcon.inbox, badge: app.inboxCount, isCurrent: isRoot(.inbox)) { router.show(.inbox) }
                DrawerItem(title: "Tasks", icon: RoomoteIcon.tasks, isCurrent: isRoot(.tasks)) { router.show(.tasks) }
                DrawerItem(title: "Automations", icon: RoomoteIcon.automations) { safariURL = app.webURL(path: "/automations") }
                DrawerItem(title: "Analytics", icon: RoomoteIcon.analytics) { safariURL = app.webURL(path: "/analytics") }
                DrawerItem(title: "Settings", icon: RoomoteIcon.settings, isCurrent: isRoot(.settings)) { router.show(.settings) }
            }
            .padding(.horizontal, 8)

            Text("Recent sessions")
                .font(RoomoteTheme.font(14, weight: .bold))
                .foregroundStyle(RoomoteTheme.foreground)
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 8)

            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(recent.sessions.prefix(20)) { session in
                        RecentSessionRow(session: session, isSelected: router.currentSessionID == session.id) {
                            router.screen = .sessions
                            router.path = [.session(id: session.id)]
                            router.drawerOpen = false
                        }
                    }
                    if recent.state.isLoading {
                        ProgressView().padding()
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 16)
            }
        }
        .background(RoomoteTheme.background.ignoresSafeArea())
        .task { await recent.load(showLoading: recent.sessions.isEmpty) }
        .safariSheet(url: $safariURL)
    }

    private func isRoot(_ screen: Router.Screen) -> Bool {
        router.screen == screen && router.path.isEmpty
    }
}

private struct DrawerItem: View {
    let title: String
    let icon: String
    var badge: Int = 0
    var isCurrent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .regular))
                    .frame(width: 24)
                Text(title)
                    .font(RoomoteTheme.font(18))
                if badge > 0 {
                    Text(String(badge))
                        .font(RoomoteTheme.font(11, weight: .semibold))
                        .foregroundStyle(RoomoteTheme.warningForeground)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(RoomoteTheme.accent, in: Capsule())
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(RoomoteTheme.foreground)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isCurrent ? RoomoteTheme.muted : .clear, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
        }
        .buttonStyle(GhostButtonStyle())
    }
}

private struct RecentSessionRow: View {
    let session: Session
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(session.displayTitle)
                    .font(RoomoteTheme.font(14, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
                SessionStatusDot(session: session)
            }
            .foregroundStyle(isSelected ? RoomoteTheme.warningForeground : RoomoteTheme.mutedForeground)
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? RoomoteTheme.accent : .clear, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
        }
        .buttonStyle(GhostButtonStyle())
    }
}

/// Trailing indicator: amber when the session needs the user, a hollow ring while active.
struct SessionStatusDot: View {
    let session: Session

    var body: some View {
        switch session.indicator {
        case .attention:
            Circle().fill(RoomoteTheme.warning).frame(width: 8, height: 8)
        case .active:
            Circle().strokeBorder(.primary.opacity(0.7), lineWidth: 1.5).frame(width: 8, height: 8)
        case .none:
            EmptyView()
        }
    }
}

extension Session {
    enum Indicator { case attention, active, none }

    var indicator: Indicator {
        let status = (cachedStatus ?? "").lowercased()
        if unread || status == "needs_input" || status == "blocked" { return .attention }
        if status == "active" || status == "running" || isResponding() { return .active }
        return .none
    }

    var needsInput: Bool { (cachedStatus ?? "").lowercased() == "needs_input" }
    var isBlocked: Bool { (cachedStatus ?? "").lowercased() == "blocked" }
}

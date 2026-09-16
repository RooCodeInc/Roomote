import SwiftUI
import UserNotifications
import RoomoteKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmSignOut = false
    @State private var isSigningOut = false

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                SettingsCard(title: "Profile", icon: RoomoteIcon.idCard) {
                    if let user = app.me?.user {
                        HStack(spacing: 12) {
                            Avatar(name: user.displayName, imageURL: user.imageUrl, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName).font(RoomoteTheme.font(14, weight: .medium)).foregroundStyle(RoomoteTheme.foreground)
                                if let email = user.email {
                                    Text(email).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
                                }
                            }
                        }
                    } else {
                        Text("Loading…").font(RoomoteTheme.font(14)).foregroundStyle(RoomoteTheme.mutedForeground)
                    }
                }

                NotificationSettingsCard()

                SettingsCard(title: "Deployment", icon: RoomoteIcon.environment) {
                    SettingsRow(label: "Host", value: app.deploymentHost)
                    if app.usesDeploymentOverride {
                        Text("Overriding the built-in deployment").font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
                    }
                    SettingsRow(label: "Version", value: NotificationManager.appVersion)
                    SettingsRow(label: "Environment", value: NotificationManager.environment)
                }

                Button {
                    confirmSignOut = true
                } label: {
                    HStack {
                        Text("Sign out").font(RoomoteTheme.font(14, weight: .medium))
                        if isSigningOut { ProgressView().controlSize(.small).tint(RoomoteTheme.destructive) }
                    }
                    .foregroundStyle(RoomoteTheme.destructive)
                    .padding(.horizontal, 16)
                    .frame(height: 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(GhostButtonStyle())
                .disabled(isSigningOut)
            }
            .padding(16)
        }
        .background(RoomoteTheme.background)
        .confirmationDialog("Sign out of \(app.deploymentHost)?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task {
                    isSigningOut = true
                    await app.signOut()
                    isSigningOut = false
                }
            }
        }
        .task {
            if app.me == nil { await app.loadMe() }
        }
    }
}

private struct SettingsCard<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        RoomoteCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: icon).font(.system(size: 16, weight: .regular))
                    Text(title).font(RoomoteTheme.font(16, weight: .medium))
                }
                .foregroundStyle(RoomoteTheme.foreground)
                content
            }
        }
    }
}

private struct SettingsRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label).font(RoomoteTheme.font(14)).foregroundStyle(RoomoteTheme.foreground)
            Spacer()
            Text(value).font(RoomoteTheme.font(14)).foregroundStyle(RoomoteTheme.mutedForeground).lineLimit(1)
        }
    }
}

private struct NotificationSettingsCard: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let notifications = app.notifications!
        SettingsCard(title: "Notifications", icon: "bell") {
            switch notifications.authorizationStatus {
            case .denied:
                Text("Notifications are turned off in iOS Settings.").font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
                SmallButton(title: "Open iOS Settings", kind: .outline) {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            case .notDetermined:
                SmallButton(title: "Enable notifications", kind: .primary) {
                    Task { await notifications.requestAuthorizationAndRegister() }
                }
            default:
                EmptyView()
            }
            toggle("Questions for you", \.userInput)
            toggle("Approvals", \.capabilityOffer)
            toggle("Task finished", \.taskSettled)
            toggle("Replies", \.reply)
            if notifications.deviceToken == nil {
                Text("This device is not registered for push yet.").font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
            }
            if let error = notifications.registrationError ?? notifications.lastSyncError {
                Text(error).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.destructive)
            }
        }
        .task { await notifications.refreshAuthorizationStatus() }
    }

    private func toggle(_ label: String, _ keyPath: WritableKeyPath<NotificationCategories, Bool>) -> some View {
        Toggle(label, isOn: binding(keyPath))
            .font(RoomoteTheme.font(14))
            .foregroundStyle(RoomoteTheme.foreground)
            .tint(RoomoteTheme.accent)
    }

    private func binding(_ keyPath: WritableKeyPath<NotificationCategories, Bool>) -> Binding<Bool> {
        Binding(
            get: { app.notifications.categories[keyPath: keyPath] },
            set: { value in
                var categories = app.notifications.categories
                categories[keyPath: keyPath] = value
                app.notifications.setCategories(categories)
            }
        )
    }
}

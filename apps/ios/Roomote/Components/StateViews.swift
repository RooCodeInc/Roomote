import SwiftUI

struct ErrorStateView: View {
    let message: String
    var retry: (() async -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(RoomoteTheme.mutedForeground)
            Text("Something went wrong").font(RoomoteTheme.font(16, weight: .medium)).foregroundStyle(RoomoteTheme.foreground)
            Text(message).font(RoomoteTheme.font(14)).foregroundStyle(RoomoteTheme.mutedForeground).multilineTextAlignment(.center)
            if let retry {
                SmallButton(title: "Try again", kind: .outline) { Task { await retry() } }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct EmptyStateView: View {
    let title: String
    var systemImage: String = RoomoteIcon.inbox
    var description: String? = nil

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(RoomoteTheme.mutedForeground)
            Text(title).font(RoomoteTheme.font(16, weight: .medium)).foregroundStyle(RoomoteTheme.foreground)
            if let description {
                Text(description).font(RoomoteTheme.font(14)).foregroundStyle(RoomoteTheme.mutedForeground).multilineTextAlignment(.center)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct LoadingStateView: View {
    var body: some View {
        ProgressView()
            .controlSize(.large)
            .tint(RoomoteTheme.mutedForeground)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Inline error shown above lists and composers.
struct InlineErrorBanner: View {
    let message: String
    var dismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(RoomoteTheme.destructive)
            Text(message).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.foreground)
            Spacer(minLength: 0)
            if let dismiss {
                Button { dismiss() } label: { Image(systemName: RoomoteIcon.close).font(.system(size: 12)) }
                    .buttonStyle(.plain)
                    .foregroundStyle(RoomoteTheme.mutedForeground)
            }
        }
        .padding(10)
        .background(RoomoteTheme.destructive.opacity(0.10), in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

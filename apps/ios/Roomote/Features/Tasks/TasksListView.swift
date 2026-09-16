import SwiftUI
import RoomoteKit

struct TasksListView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var model = TasksListModel()

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Group {
                switch model.state {
                case .idle, .loading:
                    LoadingStateView()
                case .failed(let message):
                    ErrorStateView(message: message) { await model.load() }
                case .loaded(let tasks):
                    if tasks.isEmpty {
                        EmptyStateView(title: "No tasks yet", systemImage: RoomoteIcon.tasks, description: "Tasks that Roomote runs in a sandbox show up here.")
                    } else {
                        list(tasks)
                    }
                }
            }
        }
        .background(RoomoteTheme.background)
        .task { await model.load() }
        .task(id: app.refreshToken) {
            if app.refreshToken > 0 { await model.load(showLoading: false) }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Text("Tasks").font(RoomoteTheme.font(16, weight: .medium)).foregroundStyle(RoomoteTheme.foreground)
            Spacer(minLength: 0)
            GhostIconButton(RoomoteIcon.sliders, label: "Filters", tint: RoomoteTheme.mutedForeground, size: 16, frame: 32) {}
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(RoomoteTheme.background)
        .overlay(alignment: .bottom) { Rectangle().fill(RoomoteTheme.card).frame(height: 4) }
    }

    private func list(_ tasks: [RoomoteTask]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let error = model.listError {
                    InlineErrorBanner(message: error) { model.listError = nil }
                }
                ForEach(tasks) { task in
                    Button {
                        router.push(.task(id: task.id))
                    } label: {
                        TaskRow(task: task)
                    }
                    .buttonStyle(RowButtonStyle())
                    .task { await model.loadMoreIfNeeded(current: task) }
                    Rectangle().fill(RoomoteTheme.card).frame(height: 1)
                }
                if model.isLoadingMore {
                    ProgressView().tint(RoomoteTheme.mutedForeground).padding()
                }
            }
        }
        .refreshable { await model.load(showLoading: false) }
    }
}

struct TaskRow: View {
    let task: RoomoteTask
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            avatarCluster
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(RoomoteLabels.stateLabel(task.state)).lineLimit(1)
                    Spacer(minLength: 0)
                    RelativeTimeText(date: task.activityAt).lineLimit(1).layoutPriority(1)
                }
                .font(RoomoteTheme.font(12))
                .foregroundStyle(RoomoteTheme.mutedForeground)
                Text(task.displayTitle)
                    .font(RoomoteTheme.font(18, weight: .medium))
                    .foregroundStyle(RoomoteTheme.foreground)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 10) {
                    if let repository = task.repositoryName, !repository.isEmpty {
                        ChipLabel(icon: RoomoteIcon.environment, text: RoomoteLabels.environmentLabel(repository))
                    }
                    ChipLabel(icon: RoomoteIcon.brain, text: RoomoteLabels.modelLabel(task.model))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// User avatar overlapped by a muted circle carrying the task icon.
    private var avatarCluster: some View {
        ZStack(alignment: .topLeading) {
            Avatar(name: app.me?.user.displayName, imageURL: app.me?.user.imageUrl, size: 32)
            ZStack {
                Circle().fill(RoomoteTheme.muted)
                Circle().stroke(RoomoteTheme.background, lineWidth: 2)
                Image(systemName: RoomoteIcon.fileText)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(RoomoteTheme.foreground)
            }
            .frame(width: 32, height: 32)
            .offset(x: 18, y: 14)
        }
        .frame(width: 50, height: 46, alignment: .topLeading)
    }
}

extension RoomoteLabels {
    /// "in_progress" -> "In progress".
    static func stateLabel(_ state: String) -> String {
        let text = state.replacingOccurrences(of: "_", with: " ")
        return text.isEmpty ? "Task" : text.prefix(1).uppercased() + text.dropFirst()
    }
}

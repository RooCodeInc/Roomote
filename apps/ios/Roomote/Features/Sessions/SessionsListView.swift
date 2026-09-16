import SwiftUI
import RoomoteKit

struct SessionsListView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var model = SessionsListModel()
    @State private var searchVisible = false
    @State private var boardMode = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Group {
                switch model.state {
                case .idle, .loading:
                    LoadingStateView()
                case .failed(let message):
                    ErrorStateView(message: message) { await model.load() }
                case .loaded(let sessions):
                    if sessions.isEmpty {
                        EmptyStateView(
                            title: model.query.isEmpty ? "No sessions yet" : "No matches",
                            systemImage: RoomoteIcon.messagesSquare,
                            description: model.query.isEmpty ? "Start a session to talk to Roomote." : "Try a different search."
                        )
                    } else {
                        list(sessions)
                    }
                }
            }
        }
        .background(RoomoteTheme.background)
        .onAppear {
            if router.sessionsSearchRequested {
                router.sessionsSearchRequested = false
                searchVisible = true
                searchFocused = true
            }
        }
        .task(id: model.query) {
            if !model.query.isEmpty {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            await model.load()
        }
        .task(id: app.refreshToken) {
            if app.refreshToken > 0 { await model.load(showLoading: false) }
        }
    }

    private var toolbar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 2) {
                ToolbarIcon(RoomoteIcon.messagesSquare, label: "All sessions")
                ToolbarIcon(RoomoteIcon.activity, label: "Status")
                ToolbarIcon(RoomoteIcon.userRound, label: "Owner")
                ToolbarIcon(RoomoteIcon.calendar, label: "Date")
                ToolbarIcon(RoomoteIcon.sliders, label: "Filters")
                ToolbarIcon(RoomoteIcon.search, label: "Search", tint: searchVisible ? RoomoteTheme.foreground : RoomoteTheme.mutedForeground) {
                    withAnimation(.snappy) { searchVisible.toggle() }
                    if searchVisible {
                        searchFocused = true
                    } else {
                        model.query = ""
                    }
                }
                Spacer(minLength: 0)
                ViewToggle(boardMode: $boardMode)
            }
            if searchVisible {
                HStack(spacing: 8) {
                    Image(systemName: RoomoteIcon.search).font(.system(size: 14)).foregroundStyle(RoomoteTheme.mutedForeground)
                    TextField("Search sessions", text: Bindable(model).query)
                        .font(RoomoteTheme.font(14))
                        .textFieldStyle(.plain)
                        .focused($searchFocused)
                        .submitLabel(.search)
                    if !model.query.isEmpty {
                        Button { model.query = "" } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(RoomoteTheme.mutedForeground)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 10)
                .frame(height: 36)
                .background(RoomoteTheme.card, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg).stroke(RoomoteTheme.input, lineWidth: 1))
            }
        }
        .padding(16)
        .background(RoomoteTheme.background)
        .overlay(alignment: .bottom) { Rectangle().fill(RoomoteTheme.card).frame(height: 4) }
    }

    private func list(_ sessions: [Session]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let error = model.listError {
                    InlineErrorBanner(message: error) { model.listError = nil }
                }
                ForEach(sessions) { session in
                    Button {
                        model.markRead(id: session.id)
                        router.push(.session(id: session.id))
                    } label: {
                        SessionRow(session: session)
                    }
                    .buttonStyle(RowButtonStyle())
                    .task { await model.loadMoreIfNeeded(current: session) }
                    Rectangle().fill(RoomoteTheme.card).frame(height: 1)
                }
                if model.isLoadingMore {
                    ProgressView().tint(RoomoteTheme.mutedForeground).padding()
                }
            }
        }
        .refreshable { await model.load(showLoading: false) }
        .scrollDismissesKeyboard(.immediately)
    }
}

private struct ToolbarIcon: View {
    let systemName: String
    let label: String
    var tint: Color = RoomoteTheme.mutedForeground
    var action: () -> Void = {}

    init(_ systemName: String, label: String, tint: Color = RoomoteTheme.mutedForeground, action: @escaping () -> Void = {}) {
        self.systemName = systemName
        self.label = label
        self.tint = tint
        self.action = action
    }

    var body: some View {
        GhostIconButton(systemName, label: label, tint: tint, size: 16, frame: 32, action: action)
    }
}

/// List / board segmented toggle (board is a visual placeholder on mobile).
private struct ViewToggle: View {
    @Binding var boardMode: Bool

    var body: some View {
        HStack(spacing: 0) {
            segment(RoomoteIcon.list, selected: !boardMode, label: "List") { boardMode = false }
            segment(RoomoteIcon.columns, selected: boardMode, label: "Board") { boardMode = true }
        }
        .padding(2)
        .overlay(RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg).stroke(RoomoteTheme.border, lineWidth: 1))
    }

    private func segment(_ icon: String, selected: Bool, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(selected ? RoomoteTheme.foreground : RoomoteTheme.mutedForeground)
                .frame(width: 28, height: 26)
                .background(selected ? RoomoteTheme.muted : .clear, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.md))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AvatarWithUnread(name: session.ownerName, imageURL: session.ownerImageUrl, unread: session.unread)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(session.ownerName?.isEmpty == false ? session.ownerName! : "Someone") started a session")
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    RelativeTimeText(date: session.activityAt)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                .font(RoomoteTheme.font(12))
                .foregroundStyle(RoomoteTheme.mutedForeground)
                Text(session.displayTitle)
                    .font(RoomoteTheme.font(16, weight: .medium))
                    .foregroundStyle(RoomoteTheme.foreground)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 8) {
                    SessionStatusBadge(session: session)
                    Text(RoomoteLabels.sourceLabel(session.sourceSurface))
                    if session.isResponding() {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.mini).tint(RoomoteTheme.mutedForeground)
                            Text("Responding")
                        }
                    }
                    if let pr = session.pullRequests.first {
                        ChipLabel(icon: RoomoteIcon.pullRequest, text: pr.title)
                    }
                }
                .font(RoomoteTheme.font(12))
                .foregroundStyle(RoomoteTheme.mutedForeground)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

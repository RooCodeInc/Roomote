import SwiftUI
import RoomoteKit

struct TaskDetailView: View {
    let taskID: String
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var model: TaskDetailModel
    @State private var confirmCancel = false
    @State private var safariURL: URL?

    init(taskID: String) {
        self.taskID = taskID
        _model = State(initialValue: TaskDetailModel(taskID: taskID))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            switch model.state {
            case .idle, .loading:
                LoadingStateView()
            case .failed(let message):
                ErrorStateView(message: message) { await model.load() }
            case .loaded:
                content
            }
            if let error = model.actionError {
                InlineErrorBanner(message: error) { model.actionError = nil }
            }
            if !model.isTerminal {
                RoomoteComposer(
                    placeholder: "Steer this task",
                    text: Bindable(model).steerText,
                    isSending: model.isSteering,
                    modelLabel: RoomoteLabels.modelLabel(model.task?.model)
                ) {
                    Task { await model.steer() }
                }
            }
        }
        .background(RoomoteTheme.background)
        .confirmationDialog("Cancel this task?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel task", role: .destructive) { Task { await model.cancel() } }
            Button("Keep running", role: .cancel) {}
        } message: {
            Text("The sandbox stops and any unfinished work is discarded.")
        }
        .safariSheet(url: $safariURL)
        .task { await model.load() }
        .onDisappear { model.stop() }
    }

    private var header: some View {
        DetailHeader {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    RobotAvatar(id: taskID, size: 20)
                    (Text("Task: ").font(RoomoteTheme.font(14, weight: .bold))
                        + Text(model.task?.displayTitle ?? "Task").font(RoomoteTheme.font(14, weight: .medium)))
                        .foregroundStyle(RoomoteTheme.foreground)
                        .lineLimit(1)
                }
                HStack(spacing: 8) {
                    Text(RoomoteLabels.modelLabel(model.task?.model))
                        .font(RoomoteTheme.font(12))
                        .foregroundStyle(RoomoteTheme.mutedForeground)
                    if let repository = model.task?.repositoryName, !repository.isEmpty {
                        ChipLabel(icon: RoomoteIcon.environment, text: RoomoteLabels.environmentLabel(repository))
                    }
                    if let task = model.task {
                        Text(RoomoteLabels.stateLabel(task.state))
                            .font(RoomoteTheme.font(12))
                            .foregroundStyle(RoomoteTheme.mutedForeground)
                    }
                }
            }
        } trailing: {
            HStack(spacing: 0) {
                if !model.isTerminal, model.task != nil {
                    GhostIconButton(RoomoteIcon.stop, label: "Cancel task", tint: RoomoteTheme.destructive, size: 16) {
                        confirmCancel = true
                    }
                    .disabled(model.isCancelling)
                }
                GhostIconButton(RoomoteIcon.externalLink, label: "Open in browser", tint: RoomoteTheme.mutedForeground, size: 16) {
                    safariURL = app.webURL(path: "/task/\(taskID)")
                }
                GhostIconButton(RoomoteIcon.close, label: "Back", tint: RoomoteTheme.mutedForeground, size: 16) { router.pop() }
            }
        }
    }

    private var content: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if let task = model.task {
                        if let pullRequests = task.pullRequests, !pullRequests.isEmpty {
                            RoomoteCard(padding: 12) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Pull requests").font(RoomoteTheme.font(12, weight: .medium)).foregroundStyle(RoomoteTheme.mutedForeground)
                                    ForEach(pullRequests) { pr in
                                        Button { safariURL = URL(string: pr.prUrl) } label: {
                                            HStack(spacing: 8) {
                                                Image(systemName: RoomoteIcon.pullRequest).font(.system(size: 13))
                                                Text(pr.title).lineLimit(1)
                                                Spacer(minLength: 0)
                                                if let status = pr.status { Text(status).foregroundStyle(RoomoteTheme.mutedForeground) }
                                            }
                                            .font(RoomoteTheme.font(14))
                                            .foregroundStyle(RoomoteTheme.foreground)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        if let artifacts = task.artifacts, !artifacts.isEmpty {
                            RoomoteCard(padding: 12) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Artifacts").font(RoomoteTheme.font(12, weight: .medium)).foregroundStyle(RoomoteTheme.mutedForeground)
                                    ArtifactsGallery(artifacts: artifacts)
                                }
                            }
                        }
                    }
                    TaskTranscriptView(model: model)
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refresh() }
            .onChange(of: model.envelopes.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }
}

/// Task transcript rendered from untyped envelopes.
private struct TaskTranscriptView: View {
    let model: TaskDetailModel
    @Environment(AppModel.self) private var app

    private enum Row: Identifiable {
        case prompt(Envelope), assistant(Envelope), userInput(Envelope, UserInputRequest, pending: Bool), tools(id: String, [Envelope]), streaming(String, String)

        var id: String {
            switch self {
            case .prompt(let envelope), .assistant(let envelope), .userInput(let envelope, _, _): envelope.id
            case .tools(let id, _): id
            case .streaming(let id, _): "streaming-\(id)"
            }
        }
    }

    private var rows: [Row] {
        let answered = Set(model.envelopes.compactMap { envelope -> String? in
            guard envelope.typedEventType == .requestUserInputResponse else { return nil }
            return envelope.raw["payload"]?["requestId"]?.stringValue
        })
        var rows: [Row] = []
        var tools: [Envelope] = []
        func flush() {
            if let first = tools.first { rows.append(.tools(id: "tools-\(first.id)", tools)); tools = [] }
        }
        for envelope in model.envelopes {
            if envelope.isToolEvent {
                if envelope.typedEventType == .requestUserInputResponse || envelope.typedEventType == .capabilityOfferResponse { continue }
                tools.append(envelope)
                continue
            }
            flush()
            if envelope.isUserPrompt, envelope.text != nil {
                rows.append(.prompt(envelope))
            } else if let request = envelope.userInputRequest {
                rows.append(.userInput(envelope, request, pending: !answered.contains(request.requestId)))
            } else if envelope.text != nil {
                rows.append(.assistant(envelope))
            }
        }
        flush()
        for chunk in model.streaming { rows.append(.streaming(chunk.eventId, chunk.text)) }
        return rows
    }

    var body: some View {
        if let error = model.transcriptError {
            Text(error).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.destructive)
        }
        let rows = rows
        if rows.isEmpty {
            Text("No transcript yet.").font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
        }
        ForEach(rows) { row in
            switch row {
            case .prompt(let envelope):
                UserPromptRow(
                    text: envelope.text ?? "",
                    date: envelope.date ?? Date(),
                    trailingAvatar: (
                        name: envelope.raw["userName"]?.stringValue ?? app.me?.user.displayName,
                        imageURL: envelope.raw["userImageUrl"]?.stringValue ?? app.me?.user.imageUrl
                    )
                )
            case .assistant(let envelope):
                AssistantTextRow(text: envelope.text)
            case .streaming(_, let text):
                AssistantTextRow(text: text, isStreaming: true)
            case .userInput(_, let request, let pending):
                if pending {
                    RoomoteCard {
                        QuestionsForm(questions: request.questions) { answers in
                            try await model.answer(requestId: request.requestId, answers: answers)
                        }
                    }
                } else {
                    ResolvedCard(title: "Answered", lines: request.questions.map(\.question))
                }
            case .tools(_, let envelopes):
                ToolActivityGroup(rows: envelopes.map(ToolActivityRow.init(envelope:)), isLive: isLive(envelopes))
            }
        }
    }

    private func isLive(_ envelopes: [Envelope]) -> Bool {
        guard !model.isTerminal, model.streaming.isEmpty, let last = model.envelopes.last else { return false }
        return envelopes.contains { $0.id == last.id }
    }
}

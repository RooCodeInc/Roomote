import SwiftUI
import RoomoteKit

struct SessionDetailView: View {
    let sessionID: String
    @Environment(Router.self) private var router
    @State private var model: SessionDetailModel

    init(sessionID: String) {
        self.sessionID = sessionID
        _model = State(initialValue: SessionDetailModel(sessionID: sessionID))
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
                transcript
            }
            if let error = model.actionError {
                InlineErrorBanner(message: error) { model.actionError = nil }
            }
            RoomoteComposer(
                placeholder: "Message agent",
                text: Bindable(model).composerText,
                isSending: model.isSending,
                modelLabel: RoomoteLabels.modelLabel(model.model)
            ) {
                Task { await model.send() }
            }
        }
        .background(RoomoteTheme.background)
        .task { await model.load() }
        .onDisappear { model.stop() }
    }

    private var header: some View {
        DetailHeader {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.displayTitle)
                    .font(RoomoteTheme.font(14, weight: .medium))
                    .foregroundStyle(RoomoteTheme.foreground)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(RoomoteLabels.modelLabel(model.model))
                    if model.responding, model.streaming.isEmpty {
                        ProgressView().controlSize(.mini).tint(RoomoteTheme.mutedForeground)
                    }
                }
                .font(RoomoteTheme.font(12))
                .foregroundStyle(RoomoteTheme.mutedForeground)
            }
        } trailing: {
            GhostIconButton(RoomoteIcon.collapse, label: "Back", tint: RoomoteTheme.mutedForeground) { router.pop() }
        }
    }

    private var transcript: some View {
        let items = TranscriptBuilder.build(messages: model.messages, streaming: model.streaming, linkedTasks: model.session?.linkedTasks ?? [])
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if items.isEmpty {
                        EmptyStateView(title: "No messages yet", systemImage: RoomoteIcon.messagesSquare, description: "Send a message to get started.")
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(items) { item in
                        row(for: item).id(item.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: items.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: model.streaming.last?.text.count ?? 0) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    @ViewBuilder
    private func row(for item: TranscriptItem) -> some View {
        switch item {
        case .userPrompt(let message):
            UserPromptRow(text: message.text ?? "", date: message.createdAt, imageURLs: message.imageURLs)
        case .assistant(let message):
            AssistantTextRow(text: message.text, imageURLs: message.imageURLs)
        case .streaming(_, let text):
            AssistantTextRow(text: text, isStreaming: true)
        case .userInput(_, let request, let pending):
            if pending {
                RoomoteCard {
                    QuestionsForm(questions: request.questions) { answers in
                        try await model.answer(requestId: request.requestId, answers: answers)
                    } onCancel: {
                        try await model.cancelRequest(requestId: request.requestId)
                    }
                }
            } else {
                ResolvedCard(title: "Answered", lines: request.questions.map { $0.question.isEmpty ? $0.header : $0.question })
            }
        case .offer(_, let offer, let pending):
            if pending {
                RoomoteCard {
                    CapabilityOfferForm(offer: offer) { approve in
                        try await model.respondToOffer(offer, approve: approve)
                    }
                }
            } else {
                ResolvedCard(title: "\(offer.capabilityTitle) resolved", lines: offer.message.isEmpty ? [] : [offer.message])
            }
        case .tools(_, let messages):
            ToolActivityGroup(rows: messages.map(ToolActivityRow.init(message:)), isLive: isLive(messages))
        case .delegatedTask(_, let taskId, let title):
            CodingAgentCard(taskID: taskId, title: title)
        case .cancelled:
            HStack(spacing: 6) {
                Image(systemName: RoomoteIcon.stop).font(.system(size: 12))
                Text("Cancelled")
            }
            .font(RoomoteTheme.font(12))
            .foregroundStyle(RoomoteTheme.mutedForeground)
            .frame(maxWidth: .infinity)
        }
    }

    /// The last tool group is "Working" while the agent is still responding.
    private func isLive(_ messages: [Message]) -> Bool {
        guard model.responding, model.streaming.isEmpty, let last = model.messages.last else { return false }
        return messages.contains { $0.id == last.id }
    }
}

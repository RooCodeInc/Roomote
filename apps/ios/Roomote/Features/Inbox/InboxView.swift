import SwiftUI
import RoomoteKit

struct InboxView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @State private var model = InboxModel()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Inbox").font(RoomoteTheme.font(16, weight: .medium)).foregroundStyle(RoomoteTheme.foreground)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .overlay(alignment: .bottom) { Rectangle().fill(RoomoteTheme.card).frame(height: 4) }
            Group {
                switch model.state {
                case .idle, .loading:
                    LoadingStateView()
                case .failed(let message):
                    ErrorStateView(message: message) { await model.load() }
                case .loaded(let items):
                    if items.isEmpty {
                        EmptyStateView(title: "Nothing is waiting on you.", systemImage: RoomoteIcon.inbox, description: "Questions and approvals from your sessions show up here.")
                    } else {
                        list(items)
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

    private func list(_ items: [InboxItem]) -> some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if let error = model.actionError {
                    InlineErrorBanner(message: error) { model.actionError = nil }
                }
                ForEach(items) { item in
                    InboxItemCard(item: item, model: model) {
                        router.push(.session(id: item.routingSessionId))
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await model.load(showLoading: false) }
    }
}

private struct InboxItemCard: View {
    let item: InboxItem
    let model: InboxModel
    let openSession: () -> Void

    var body: some View {
        RoomoteCard {
            VStack(alignment: .leading, spacing: 12) {
                Button(action: openSession) {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 8) {
                                Text(kindLabel)
                                RelativeTimeText(date: item.createdAt)
                            }
                            .font(RoomoteTheme.font(12))
                            .foregroundStyle(RoomoteTheme.mutedForeground)
                            Text(item.sessionTitle.isEmpty ? "Untitled session" : item.sessionTitle)
                                .font(RoomoteTheme.font(16, weight: .medium))
                                .foregroundStyle(RoomoteTheme.foreground)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: RoomoteIcon.chevronRight)
                            .font(.system(size: 14))
                            .foregroundStyle(RoomoteTheme.mutedForeground)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                switch item.typedKind {
                case .userInput:
                    if let request = item.request {
                        QuestionsForm(questions: request.questions) { answers in
                            try await model.answer(item: item, answers: answers)
                        }
                    }
                case .capabilityOffer:
                    if let offer = item.offer {
                        CapabilityOfferForm(offer: offer) { approve in
                            try await model.respond(item: item, approve: approve)
                        }
                    }
                case .none:
                    Text("Open the session to respond.").font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
                }
            }
        }
    }

    private var kindLabel: String {
        switch item.typedKind {
        case .userInput: "Needs your answer"
        case .capabilityOffer: "Needs your approval"
        case .none: item.kind
        }
    }
}

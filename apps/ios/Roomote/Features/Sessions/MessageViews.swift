import SwiftUI
import RoomoteKit

/// User prompt: a `foreground/10` bubble that collapses past ~300pt, then a
/// right-aligned actions row (copy, open, timestamp).
struct UserPromptRow: View {
    let text: String
    let date: Date
    var imageURLs: [URL] = []
    /// When set, the bubble sits in a row with the user's avatar on the right (tasks).
    var trailingAvatar: (name: String?, imageURL: String?)? = nil

    @State private var expanded = false
    @State private var contentHeight: CGFloat = 0
    private let collapseAt: CGFloat = 300

    private var collapsible: Bool { contentHeight > collapseAt + 20 }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .trailing, spacing: 4) {
                bubble
                actions
            }
            if let trailingAvatar {
                Avatar(name: trailingAvatar.name, imageURL: trailingAvatar.imageURL, size: 32)
            }
        }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(text)
                .font(RoomoteTheme.font(14))
                .foregroundStyle(RoomoteTheme.foreground)
                .lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                .frame(maxHeight: collapsible && !expanded ? collapseAt : nil, alignment: .top)
                .clipped()
            MessageImages(urls: imageURLs)
            if collapsible {
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    Image(systemName: RoomoteIcon.chevronDown)
                        .font(.system(size: 14, weight: .regular))
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .foregroundStyle(RoomoteTheme.mutedForeground)
                        .frame(maxWidth: .infinity)
                        .frame(height: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse" : "Expand")
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoomoteTheme.userBubble, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
    }

    private var actions: some View {
        HStack(spacing: 2) {
            GhostIconButton(RoomoteIcon.copy, label: "Copy", tint: RoomoteTheme.mutedForeground, size: 13, frame: 28) {
                UIPasteboard.general.string = text
            }
            GhostIconButton(RoomoteIcon.arrowUpRight, label: "Open", tint: RoomoteTheme.mutedForeground, size: 13, frame: 28) {}
            Text(RoomoteLabels.timestamp(date))
                .font(RoomoteTheme.font(12))
                .foregroundStyle(RoomoteTheme.mutedForeground)
                .padding(.leading, 4)
        }
    }
}

/// Assistant text: plain 14pt with relaxed leading, no bubble.
struct AssistantTextRow: View {
    let text: String?
    var imageURLs: [URL] = []
    var isStreaming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let text, !text.isEmpty {
                MarkdownText(text: text).textSelection(.enabled)
            }
            MessageImages(urls: imageURLs)
            if isStreaming {
                ProgressView().controlSize(.mini).tint(RoomoteTheme.mutedForeground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MessageImages: View {
    let urls: [URL]

    var body: some View {
        if !urls.isEmpty {
            ForEach(urls, id: \.absoluteString) { url in
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else {
                        RoomoteTheme.muted
                    }
                }
                .frame(maxWidth: 240, maxHeight: 240)
                .clipShape(RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
            }
        }
    }
}

/// "Coding agent" card linking to a delegated task.
struct CodingAgentCard: View {
    let taskID: String
    let title: String?
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            router.push(.task(id: taskID))
        } label: {
            HStack(spacing: 12) {
                RobotAvatar(id: taskID, size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Coding agent").font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
                    Text(title?.isEmpty == false ? title! : "Task")
                        .font(RoomoteTheme.font(14, weight: .medium))
                        .foregroundStyle(RoomoteTheme.foreground)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: RoomoteIcon.chevronRight)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(RoomoteTheme.mutedForeground)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoomoteTheme.card, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
    }
}

/// One tool event inside an activity group.
struct ToolActivityRow: Identifiable {
    let id: String
    let title: String
    /// Tool identifier used for the "Used N ... calls" summary (never the command text).
    let toolName: String
    let isCall: Bool
    let status: String?
    let output: String?

    init(message: Message) {
        id = message.id
        title = message.toolTitle
        toolName = Self.toolName(in: message.payload) ?? "tool"
        isCall = message.typedEventType == .toolCall
        status = message.toolStatus
        output = message.toolOutput
    }

    init(envelope: Envelope) {
        id = envelope.id
        title = envelope.toolTitle
        toolName = Self.toolName(in: envelope.raw["payload"]) ?? "tool"
        isCall = envelope.typedEventType == .toolCall || envelope.typedEventType == nil
        status = envelope.raw["payload"]?["status"]?.stringValue
        output = envelope.raw["payload"]?["output"]?.stringValue ?? envelope.text
    }

    private static func toolName(in payload: JSONValue?) -> String? {
        guard let payload else { return nil }
        let candidates = [
            payload["mcpToolName"]?.stringValue,
            payload["toolName"]?.stringValue,
            payload["name"]?.stringValue,
            payload["kind"]?.stringValue,
        ]
        guard let raw = candidates.compactMap({ $0 }).first(where: { !$0.isEmpty }) else { return nil }
        return raw.split(separator: "/").last.map(String.init) ?? raw
    }
}

/// Collapsible "Worked for a bit" group plus a "Used N ... calls" summary.
struct ToolActivityGroup: View {
    let rows: [ToolActivityRow]
    var isLive = false
    @State private var expanded = false

    private var summary: (count: Int, label: String) {
        let calls = rows.filter(\.isCall)
        let counted = calls.isEmpty ? rows : calls
        let names = Dictionary(grouping: counted, by: \.toolName)
        if names.count == 1, let name = names.keys.first, name != "tool" {
            return (counted.count, RoomoteLabels.toolLabel(name))
        }
        return (counted.count, "tool")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    if isLive {
                        ProgressView().controlSize(.mini).tint(RoomoteTheme.mutedForeground)
                        Text("Working")
                    } else {
                        Text("Worked for a bit")
                    }
                    Image(systemName: RoomoteIcon.chevronRight)
                        .font(.system(size: 11, weight: .regular))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .font(RoomoteTheme.font(14, weight: .light))
                .foregroundStyle(RoomoteTheme.foreground.opacity(0.5))
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Rectangle().fill(RoomoteTheme.border.opacity(0.4)).frame(height: 1)

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Image(systemName: icon(for: row))
                                    .font(.system(size: 11))
                                    .foregroundStyle(color(for: row))
                                Text(row.title).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.foreground).lineLimit(2)
                            }
                            if let output = row.output, !output.isEmpty {
                                Text(output.prefix(300))
                                    .font(RoomoteTheme.mono(11))
                                    .foregroundStyle(RoomoteTheme.mutedForeground)
                                    .lineLimit(4)
                            }
                        }
                    }
                }
                .padding(.leading, 12)
                .padding(.vertical, 8)
                .overlay(alignment: .leading) { Rectangle().fill(RoomoteTheme.border).frame(width: 1) }
            }

            HStack(spacing: 6) {
                Image(systemName: RoomoteIcon.listChecks)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(RoomoteTheme.mutedForeground)
                (Text("Used ").fontWeight(.light)
                    + Text("\(summary.count) \(summary.label) \(summary.count == 1 ? "call" : "calls")").fontWeight(.medium))
                    .font(RoomoteTheme.font(14))
                    .foregroundStyle(RoomoteTheme.foreground)
            }
            .padding(.top, 8)
        }
    }

    private func icon(for row: ToolActivityRow) -> String {
        switch row.status {
        case "failed", "error": "xmark.circle"
        case "completed", "success": "checkmark.circle"
        case "in_progress", "running": "circle.dotted"
        default: row.isCall ? "circle" : "arrow.turn.down.left"
        }
    }

    private func color(for row: ToolActivityRow) -> Color {
        switch row.status {
        case "failed", "error": RoomoteTheme.destructive
        case "completed", "success": RoomoteTheme.accent
        default: RoomoteTheme.mutedForeground
        }
    }
}

/// Muted card for a request that has already been answered or resolved.
struct ResolvedCard: View {
    let title: String
    let lines: [String]

    var body: some View {
        RoomoteCard {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(RoomoteTheme.font(12, weight: .medium)).foregroundStyle(RoomoteTheme.mutedForeground)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    MarkdownText(text: line, color: RoomoteTheme.mutedForeground)
                }
            }
        }
    }
}

/// Sticky header card shared by Session and task detail.
struct DetailHeader<Leading: View, Trailing: View>: View {
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            leading
            Spacer(minLength: 4)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(RoomoteTheme.card)
        .overlay(alignment: .bottom) { Rectangle().fill(RoomoteTheme.card).frame(height: 2) }
    }
}

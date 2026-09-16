import SwiftUI

/// rounded-lg card: 1pt border, `card` background, 16pt padding.
struct RoomoteCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoomoteTheme.card, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg).stroke(RoomoteTheme.border, lineWidth: 1))
    }
}

/// 12pt icon + text chip in muted foreground.
struct ChipLabel: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 12, weight: .regular))
            Text(text).lineLimit(1)
        }
        .font(RoomoteTheme.font(12))
        .foregroundStyle(RoomoteTheme.mutedForeground)
    }
}

enum StatusBadgeKind { case warning, destructive, outline }

/// Small filled status badge (needs input / blocked).
struct StatusBadge: View {
    let text: String
    var kind: StatusBadgeKind = .outline

    var body: some View {
        Text(text)
            .font(RoomoteTheme.font(12, weight: .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(background, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.md))
            .overlay {
                if kind == .outline {
                    RoundedRectangle(cornerRadius: RoomoteTheme.Radius.md).stroke(RoomoteTheme.border, lineWidth: 1)
                }
            }
    }

    private var foreground: Color {
        switch kind {
        case .warning: RoomoteTheme.warningForeground
        case .destructive: .white
        case .outline: RoomoteTheme.mutedForeground
        }
    }

    private var background: Color {
        switch kind {
        case .warning: RoomoteTheme.warning
        case .destructive: RoomoteTheme.destructive
        case .outline: .clear
        }
    }
}

/// Session/task status chip, or nothing when the state needs no attention.
struct SessionStatusBadge: View {
    let session: Session

    var body: some View {
        if session.needsInput {
            StatusBadge(text: "Needs input", kind: .warning)
        } else if session.isBlocked {
            StatusBadge(text: "Blocked", kind: .destructive)
        }
    }
}

import RoomoteKit

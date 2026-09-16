import SwiftUI

/// Transparent button that tints its background while pressed.
struct GhostButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = RoomoteTheme.Radius.lg

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? RoomoteTheme.muted : .clear, in: RoundedRectangle(cornerRadius: cornerRadius))
            .contentShape(Rectangle())
    }
}

/// Full-bleed list row: pressed state is lime at 10%.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? RoomoteTheme.rowPressed : RoomoteTheme.background)
            .contentShape(Rectangle())
    }
}

/// Square icon-only ghost button (36pt hit area, 18pt glyph).
struct GhostIconButton: View {
    let systemName: String
    var label: String
    var tint: Color = RoomoteTheme.foreground
    var size: CGFloat = 18
    var frame: CGFloat = 36
    let action: () -> Void

    init(_ systemName: String, label: String, tint: Color = RoomoteTheme.foreground, size: CGFloat = 18, frame: CGFloat = 36, action: @escaping () -> Void) {
        self.systemName = systemName
        self.label = label
        self.tint = tint
        self.size = size
        self.frame = frame
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(tint)
                .frame(width: frame, height: frame)
        }
        .buttonStyle(GhostButtonStyle())
        .accessibilityLabel(label)
    }
}

enum SmallButtonKind { case primary, ghost, outline, destructiveGhost }

/// Compact text button used in cards (Submit, Cancel, Approve, Dismiss).
struct SmallButton: View {
    let title: String
    var kind: SmallButtonKind = .primary
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(title).opacity(busy ? 0 : 1)
                if busy { ProgressView().controlSize(.small).tint(foreground) }
            }
            .font(RoomoteTheme.font(12, weight: .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(background, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
            .overlay {
                if kind == .outline {
                    RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg).stroke(RoomoteTheme.border, lineWidth: 1)
                }
            }
        }
        .buttonStyle(GhostButtonStyle())
        .disabled(busy)
    }

    private var foreground: Color {
        switch kind {
        case .primary: RoomoteTheme.primaryForeground
        case .ghost, .outline: RoomoteTheme.foreground
        case .destructiveGhost: RoomoteTheme.destructive
        }
    }

    private var background: Color {
        kind == .primary ? RoomoteTheme.primary : .clear
    }
}

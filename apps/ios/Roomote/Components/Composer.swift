import SwiftUI

/// Bottom composer shell shared by Home, Session detail, and task detail.
struct RoomoteComposer: View {
    let placeholder: String
    @Binding var text: String
    let isSending: Bool
    var modelLabel: String = "Default model"
    var autofocus = false
    let onSend: () -> Void

    @FocusState private var focused: Bool

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 24, bottomTrailingRadius: 24, topTrailingRadius: 6)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .font(RoomoteTheme.font(14))
                .foregroundStyle(RoomoteTheme.foreground)
                .padding(.horizontal, 8)
                .padding(.top, 8)
                .focused($focused)
            HStack(spacing: 2) {
                GhostIconButton(RoomoteIcon.plus, label: "Attach", tint: RoomoteTheme.mutedForeground, size: 16, frame: 32) {}
                Menu {
                    Button(modelLabel) {}
                } label: {
                    HStack(spacing: 4) {
                        Text(modelLabel)
                        Image(systemName: RoomoteIcon.chevronDown).font(.system(size: 10, weight: .regular))
                    }
                    .font(RoomoteTheme.font(12))
                    .foregroundStyle(RoomoteTheme.mutedForeground)
                    .padding(.horizontal, 8)
                    .frame(height: 32)
                }
                .buttonStyle(GhostButtonStyle())
                Spacer(minLength: 0)
                GhostIconButton(RoomoteIcon.audioLines, label: "Voice", tint: RoomoteTheme.mutedForeground, size: 16, frame: 32) {}
                GhostIconButton(RoomoteIcon.mic, label: "Dictate", tint: RoomoteTheme.mutedForeground, size: 16, frame: 32) {}
                Button(action: onSend) {
                    ZStack {
                        Circle().fill(RoomoteTheme.primary)
                        if isSending {
                            ProgressView().controlSize(.small).tint(RoomoteTheme.primaryForeground)
                        } else {
                            Image(systemName: RoomoteIcon.send)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(RoomoteTheme.primaryForeground)
                        }
                    }
                    .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .opacity(canSend ? 1 : 0.5)
                .padding(.leading, 4)
                .accessibilityLabel("Send")
            }
        }
        .padding(10)
        .background(RoomoteTheme.card, in: shape)
        .overlay(shape.stroke(focused ? RoomoteTheme.accent : RoomoteTheme.background, lineWidth: 2))
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
        .background(RoomoteTheme.background)
        .onAppear { if autofocus { focused = true } }
    }
}

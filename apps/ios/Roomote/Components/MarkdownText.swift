import SwiftUI

/// Best-effort inline markdown with a plain-text fallback. Inline code renders
/// as a Monaspace chip on `foreground/15`.
struct MarkdownText: View {
    let text: String
    var font: Font = RoomoteTheme.font(14)
    var color: Color = RoomoteTheme.foreground

    var body: some View {
        Text(attributed)
            .font(font)
            .foregroundStyle(color)
            .lineSpacing(4)
    }

    private var attributed: AttributedString {
        guard var attributed = try? AttributedString(
            markdown: text,
            options: .init(allowsExtendedAttributes: true, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        ) else {
            return AttributedString(text)
        }
        for run in attributed.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                attributed[run.range].font = RoomoteTheme.mono(12)
                attributed[run.range].backgroundColor = RoomoteTheme.inlineCode
            }
        }
        return attributed
    }
}

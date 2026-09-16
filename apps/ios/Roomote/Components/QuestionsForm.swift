import SwiftUI
import RoomoteKit

/// Inline form for a `request_user_input` request. Callers wrap it in a card.
struct QuestionsForm: View {
    let questions: [Question]
    let onSubmit: (Answers) async throws -> Void
    var onCancel: (() async throws -> Void)? = nil

    @State private var selections: [String: Set<String>] = [:]
    @State private var freeText: [String: String] = [:]
    @State private var isSubmitting = false
    @State private var isCancelling = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(questions) { question in
                QuestionField(
                    question: question,
                    selected: binding(for: question.id),
                    text: textBinding(for: question.id)
                )
            }
            if let error {
                Text(error).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.destructive)
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if onCancel != nil {
                    SmallButton(title: "Cancel", kind: .ghost, busy: isCancelling) { Task { await cancel() } }
                        .disabled(isSubmitting)
                }
                SmallButton(title: "Submit", kind: .primary, busy: isSubmitting) { Task { await submit() } }
                    .disabled(isSubmitting || !isComplete)
                    .opacity(isComplete ? 1 : 0.5)
            }
        }
    }

    private func binding(for id: String) -> Binding<Set<String>> {
        Binding(get: { selections[id] ?? [] }, set: { selections[id] = $0 })
    }

    private func textBinding(for id: String) -> Binding<String> {
        Binding(get: { freeText[id] ?? "" }, set: { freeText[id] = $0 })
    }

    private func answers(for question: Question) -> [String] {
        var values = Array(selections[question.id] ?? [])
        let text = (freeText[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if question.allowsFreeText, !text.isEmpty {
            values.append(text)
        }
        if !question.allowsMultiple, values.count > 1 {
            // A single-select question with an option and "other" text: prefer the text.
            values = [text.isEmpty ? values[0] : text]
        }
        return values
    }

    private var isComplete: Bool {
        questions.allSatisfy { !answers(for: $0).isEmpty }
    }

    private func submit() async {
        guard isComplete else { return }
        isSubmitting = true
        error = nil
        defer { isSubmitting = false }
        var payload: Answers = [:]
        for question in questions {
            payload[question.id] = AnswerValue(answers: answers(for: question))
        }
        do {
            try await onSubmit(payload)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func cancel() async {
        guard let onCancel else { return }
        isCancelling = true
        error = nil
        defer { isCancelling = false }
        do {
            try await onCancel()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct QuestionField: View {
    let question: Question
    @Binding var selected: Set<String>
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !question.header.isEmpty {
                Text(question.header)
                    .font(RoomoteTheme.font(12, weight: .medium))
                    .foregroundStyle(RoomoteTheme.mutedForeground)
            }
            if !question.question.isEmpty {
                MarkdownText(text: question.question)
            }
            if let options = question.options, !options.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                        OptionRow(
                            label: option.label,
                            description: option.description,
                            isSelected: selected.contains(option.answerValue)
                        ) {
                            toggle(option.answerValue)
                        }
                    }
                }
            }
            if question.allowsFreeText {
                Group {
                    if question.isSecret {
                        SecureField(question.hasOptions ? "Other" : "Your answer", text: $text)
                    } else {
                        TextField(question.hasOptions ? "Other" : "Your answer", text: $text, axis: .vertical)
                            .lineLimit(1...5)
                    }
                }
                .font(RoomoteTheme.font(14))
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(RoomoteTheme.background, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg).stroke(RoomoteTheme.input, lineWidth: 1))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(question.isSecret)
            }
        }
    }

    private func toggle(_ value: String) {
        if selected.contains(value) {
            selected.remove(value)
        } else if question.allowsMultiple {
            selected.insert(value)
        } else {
            selected = [value]
        }
    }
}

private struct OptionRow: View {
    let label: String
    let description: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(RoomoteTheme.font(14, weight: isSelected ? .medium : .regular))
                    if let description, !description.isEmpty {
                        Text(description).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.mutedForeground)
                    }
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .medium)).foregroundStyle(RoomoteTheme.accent)
                }
            }
            .foregroundStyle(RoomoteTheme.foreground)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? RoomoteTheme.rowPressed : .clear, in: RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: RoomoteTheme.Radius.lg).stroke(isSelected ? RoomoteTheme.accent : RoomoteTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

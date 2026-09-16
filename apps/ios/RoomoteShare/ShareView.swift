import SwiftUI

struct ShareView: View {
    @Bindable var model: ShareModel
    let onDone: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                if !model.isSignedIn {
                    Section {
                        Label("Sign in to the Roomote app first.", systemImage: "person.crop.circle.badge.exclamationmark")
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextField("What should Roomote do with this?", text: $model.text, axis: .vertical)
                        .lineLimit(4...12)
                } footer: {
                    Text("Starts a new session on \(model.deploymentHost).")
                }
                if !model.images.isEmpty {
                    Section("Images") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(Array(model.images.enumerated()), id: \.offset) { _, image in
                                    Image(uiImage: image)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 80, height: 80)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                }
                if let error = model.error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(model.isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { if await model.send() { onDone() } }
                    } label: {
                        if model.isSending { ProgressView() } else { Text("Send") }
                    }
                    .disabled(!model.canSend)
                }
            }
        }
    }
}

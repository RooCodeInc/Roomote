import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var model: SignInModel?

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    SignInForm(model: model)
                } else {
                    LoadingStateView()
                }
            }
            .navigationTitle(app.configuration.displayName)
            .scrollContentBackground(.hidden)
            .background(RoomoteTheme.background)
        }
        .tint(RoomoteTheme.primary)
        .onAppear {
            if model == nil { model = SignInModel(app: app) }
        }
    }
}

private struct SignInForm: View {
    @Bindable var model: SignInModel
    @Environment(AppModel.self) private var app
    @FocusState private var focus: Field?

    private enum Field { case email, password, host }

    var body: some View {
        Form {
            Section {
                LabeledContent("Deployment", value: model.displayHost)
                DisclosureGroup("Advanced", isExpanded: $model.showAdvanced) {
                    TextField("https://roo.example.com", text: $model.hostInput)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .host)
                        .onSubmit { model.applyHost() }
                    Button("Use this deployment") { model.applyHost() }
                        .disabled(model.hostInput == app.baseURL.absoluteString)
                }
            } footer: {
                Text("Sign in to the Roomote deployment this app was built for. Change it only if you were told to use another host.")
            }

            Section("Email") {
                TextField("Email", text: $model.email)
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
                SecureField("Password", text: $model.password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { Task { await model.signInWithPassword() } }
                Button {
                    Task { await model.signInWithPassword() }
                } label: {
                    HStack {
                        Text("Sign in")
                        if model.isBusy { Spacer(); ProgressView() }
                    }
                }
                .disabled(!model.canSubmit)
            }

            Section {
                Button {
                    Task { await model.signInWithBrowser() }
                } label: {
                    Label("Sign in with browser", systemImage: "safari")
                }
                .disabled(model.isBusy)
            } footer: {
                Text("Use this for Slack, Microsoft, or any other provider your deployment offers.")
            }

            if let error = model.errorMessage ?? app.globalError {
                Section {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            }
        }
        .onChange(of: model.errorMessage) { _, _ in
            if model.errorMessage != nil { app.globalError = nil }
        }
    }
}

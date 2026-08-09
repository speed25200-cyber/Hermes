import SwiftUI

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL: String = ""
    @State private var editing = false
    @State private var draft = ""

    var body: some View {
        ZStack {
            Color(red: 0.031, green: 0.035, blue: 0.051).ignoresSafeArea()
            if serverURL.isEmpty || editing {
                settings
            } else {
                DashboardWebView(url: URL(string: serverURL)!)
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .topTrailing) {
                        Button {
                            draft = serverURL
                            editing = true
                        } label: {
                            Image(systemName: "gearshape.fill")
                                .foregroundStyle(.secondary)
                                .padding(10)
                        }
                    }
            }
        }
    }

    private var settings: some View {
        VStack(spacing: 18) {
            Text("Hermes Console")
                .font(.title2.weight(.semibold))
            Text("Adresse du serveur Hermes (PC/VPS où tourne `python -m hermes dashboard`) :")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("http://192.168.1.20:8899", text: $draft)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .autocapitalization(.none)
                .disableAutocorrection(true)
            Button("Se connecter") {
                var url = draft.trimmingCharacters(in: .whitespaces)
                if !url.hasPrefix("http") { url = "http://" + url }
                if URL(string: url) != nil {
                    serverURL = url
                    editing = false
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(28)
    }
}

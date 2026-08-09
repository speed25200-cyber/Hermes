// Hermes Console — minimal native shell around the Hermes dashboard.
// The trading engine runs on your PC/VPS; this app is a viewer.
// Recommended alternative: install the dashboard as a PWA from Safari
// (Share > Add to Home Screen) — see ios/README.md.

import SwiftUI

@main
struct HermesConsoleApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}

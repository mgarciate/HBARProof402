import SwiftUI

struct ContentView: View {
    @State private var model = AppModel()

    var body: some View {
        Group {
            switch model.phase {
            case .tasks:
                AvailableTasksView(
                    tasks: model.tasks,
                    isLoading: model.isLoading,
                    onSelect: model.select,
                    onReload: model.loadTasks
                )
            case .payout:
                flowNavigation { PayoutAccountView(model: model) }
            case .qr:
                flowNavigation { QRStepView(model: model) }
            case .evidence:
                flowNavigation { EvidenceCaptureView(model: model) }
            case .submission:
                flowNavigation { SubmissionProgressView() }
            case .result:
                flowNavigation { TaskResultView(model: model) }
            }
        }
        .task {
            if model.tasks.isEmpty {
                await model.loadTasks()
            }
        }
        .alert(
            "Unable to Continue",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private func flowNavigation<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            content()
                .toolbar {
                    if model.phase != .submission && model.phase != .result {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Cancel", systemImage: "xmark") {
                                model.reset()
                            }
                        }
                    }
                }
        }
    }
}

#Preview {
    ContentView()
}

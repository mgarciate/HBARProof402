import SwiftUI

struct AvailableTasksView: View {
    let tasks: [FieldTask]
    let isLoading: Bool
    let onSelect: (FieldTask) -> Void
    let onReload: () async -> Void

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && tasks.isEmpty {
                    ProgressView("Finding Tasks…")
                } else if tasks.isEmpty {
                    ContentUnavailableView(
                        "No Tasks Available",
                        systemImage: "checkmark.circle",
                        description: Text("Try again in a few minutes.")
                    )
                } else {
                    List(tasks) { task in
                        Button {
                            onSelect(task)
                        } label: {
                            TaskRow(task: task)
                        }
                        .buttonStyle(.plain)
                        .disabled(task.status != .open)
                    }
                    .refreshable { await onReload() }
                }
            }
            .navigationTitle("FieldProof402")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Label("Hedera testnet", systemImage: "network")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct TaskRow: View {
    let task: FieldTask

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Image(systemName: "bicycle")
                    .font(.title2)
                    .foregroundStyle(.mint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.title)
                        .font(.headline)
                    Label(task.status.title, systemImage: task.status.systemImage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(task.rewardText)
                    .font(.headline)
                    .foregroundStyle(.mint)
            }

            Label {
                Text(task.expiresAt, style: .relative)
            } icon: {
                Image(systemName: "clock")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)

            Text("2 photos · QR required")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

struct PayoutAccountView: View {
    @Bindable var model: AppModel

    var body: some View {
        Form {
            Section("Inspection") {
                if let task = model.selectedTask {
                    Text(task.title).font(.headline)
                    Text(task.rewardText)
                        .font(.title2.bold())
                        .foregroundStyle(.mint)
                    ForEach(Array(task.instructions.enumerated()), id: \.offset) { index, instruction in
                        Label("\(index + 1). \(instruction)", systemImage: "checkmark.circle")
                    }
                }
            }

            Section("Payout Account") {
                TextField(
                    "0.0.123456",
                    text: Binding(
                        get: { model.payoutAccount },
                        set: model.updatePayoutAccount
                    )
                )
                    .textContentType(.none)
#if os(iOS)
                    .keyboardType(.numbersAndPunctuation)
#endif
                    .autocorrectionDisabled()
                    .accessibilityLabel("Hedera testnet account")

                Text("We only need the public account ID. Never enter a private key.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button {
                    Task { await model.validateAndClaim() }
                } label: {
                    HStack {
                        Spacer()
                        if model.isLoading {
                            ProgressView()
                        } else {
                            Text("Accept and Continue").bold()
                        }
                        Spacer()
                    }
                }
                .disabled(model.isLoading)
            }
        }
        .navigationTitle("Accept Task")
    }
}

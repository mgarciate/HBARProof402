import Foundation

struct AppConfiguration: Sendable {
    let apiBaseURL: URL
    let workerID: String
    let workerAPIToken: String?

    static var live: AppConfiguration {
        let environment = ProcessInfo.processInfo.environment
        let configuredURL = environment["FIELDPROOF_API_BASE_URL"]
            ?? Bundle.main.object(forInfoDictionaryKey: "FieldProofAPIBaseURL") as? String
            ?? "http://127.0.0.1:3000"
        let workerID = environment["FIELDPROOF_WORKER_ID"]
            ?? Bundle.main.object(forInfoDictionaryKey: "FieldProofWorkerID") as? String
            ?? "worker_ios_demo"
        let workerAPIToken = environment["WORKER_API_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let apiBaseURL = URL(string: configuredURL) else {
            preconditionFailure("FieldProofAPIBaseURL must be a valid URL.")
        }
        return AppConfiguration(
            apiBaseURL: apiBaseURL,
            workerID: workerID,
            workerAPIToken: workerAPIToken?.isEmpty == false ? workerAPIToken : nil
        )
    }
}

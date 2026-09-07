# Project Guidelines

## Language

- Write all source code, identifiers, comments, documentation, logs, errors, and user-facing copy in English.
- Keep protocol and blockchain terminology consistent with the FieldProof402 specification, including `task`, `claim`, `evidence`, `verification`, `reward`, `receipt`, `HCS`, `x402`, and `Hedera testnet`.
- Use clear, concise sentence case for user-facing text.

## Apple development

- Use Swift 6, SwiftUI, and structured concurrency with `async`/`await`.
- Prefer `@Observable` models and avoid Combine unless an API requires it.
- Preserve accessibility support, Dynamic Type, and VoiceOver labels when changing UI.
- Keep private images off-chain and never request or store a worker's Hedera private key.
- Build the Xcode project after source changes and resolve compiler errors before finishing.

## Scope

- Keep changes focused on the requested task.
- Do not replace real x402, Hedera, or backend behavior with claims that a mock is production functionality.
- Maintain idempotency for evidence submission and economic operations when implementing the live API.

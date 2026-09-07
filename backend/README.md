# FieldProof402 Marketplace backend

Marketplace API and persistent worker for bicycle inspection tasks. HCS messages, Mirror Node reads, x402 verification purchases through Blocky402 and HBAR rewards use **Hedera testnet**. Visual analysis remains explicitly **mock**. The requesting agent pays the verifier; an approved result triggers a separate reward to the collaborator's snapshotted Hedera account (`0.0.x`).

The existing iOS prototype is untouched. See [the mobile API contract](docs/mobile-api.md) for integration.

## Run locally

Requires Node.js 22.12+ (or Docker), Docker Compose, a funded Hedera testnet operator account and a different existing collaborator account.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env`. Replace the database/storage passwords; use matching values in `DATABASE_URL` and `POSTGRES_PASSWORD`. Set `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY`. This backend accepts SDK-supported DER private keys; do not paste keys into logs or commit them.
3. Generate three different tokens using `openssl rand -hex 32` and set `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, `OPERATOR_API_TOKEN`.
4. Run `npm run hedera:topic` once. It creates a real testnet topic whose submit/admin keys belong to the operator. Copy the printed topic ID to `HEDERA_HCS_TOPIC_ID`.
5. Set `X402_PAY_TO_ACCOUNT_ID` to the verifier's testnet account and configure the separate agent credentials as described in [x402 setup](docs/x402.md). Alternatively, set `VERIFICATION_PAYMENT_MODE=free_mock` for an unpaid verification demo. Run `docker compose up -d --build`. Database migrations run before the API and worker start. The storage initializer creates a private bucket.
6. Run `docker compose exec api node dist/scripts/seed.js` once. It prints the principal IDs, never tokens. Reusing the same tokens is idempotent; changing a token adds a principal and does not revoke the previous one.
7. Check `http://localhost:3000/health/ready` and the interactive OpenAPI docs at `http://localhost:3000/docs`.

For native development, start only dependencies with `docker compose up -d postgres storage-init`, then run `npm run db:migrate`, `npm run seed`, `npm run dev` and `npm run worker:dev` in separate terminals. Configure `OBJECT_STORAGE_PUBLIC_ENDPOINT` to an address reachable by the iPhone, not `localhost` on that phone. It must reach the same bucket as the internal endpoint.

## Reproduce the flow

Set `DEMO_PAYOUT_ACCOUNT_ID` to the collaborator's testnet account, then use two different photographs:

```bash
npm run demo -- /path/to/overview.jpg /path/to/detail.jpg
npm run receipt -- <taskId>
```

The script strips metadata, computes hashes, creates a task offering 0.1 HBAR with a 0.01 HBAR verification budget, waits for HCS, claims it and uploads evidence. For x402 tasks it buys verification using the agent's separately funded account; for legacy/free tasks verification starts automatically. It prints the actual payment mode and always identifies analysis as mock. Reusing identical photographs in another task is a rejection case. A pending Mirror Node receipt can be checked again with the receipt command; do not create another task to retry a payment.

`MOCK_VERIFIER_SCENARIO` is operator-controlled configuration: `approve` (default), `reject`, `manual_review`, or `transient_error` (fails the first attempt, then recovers). The selected scenario is persisted at submission; restarting the worker does not change an existing decision. QR and duplicate checks still reject otherwise approved scenarios. `reject` deliberately simulates a failed required-files check; it is not a real image assessment. Manual review is terminal in this MVP and does not pay a reward.

## Verification

```bash
npm run typecheck
npm test
npm run build
docker compose -f compose.test.yaml up -d --wait
npm run test:integration
docker compose -f compose.test.yaml down
```

Integration tests use actual PostgreSQL and MinIO on dedicated ports 55432 and 59000, with an in-memory ledger injected **only by tests**. They do not use `.env` Hedera credentials or spend funds. The disposable test database is reset between tests. Default unit tests skip integration explicitly; a failed integration dependency is not silently skipped when `RUN_INTEGRATION=1`.

Real Hedera end-to-end validation requires funded operator and agent credentials, a verifier recipient, a topic and photographs. Unit/integration success alone does not prove a real transfer. For x402, acceptance requires a `PAID` task, four confirmed HCS events, `checks.x402: verified`, `checks.reward: verified` and receipt status `verified_mock_flow` after Mirror Node indexing. That status describes mock analysis, not simulated payments.

## HTTPS deployment

On a Docker server, point two DNS names at its address. Set `API_DOMAIN`, `STORAGE_DOMAIN`, `API_BASE_URL=https://<API_DOMAIN>` and `OBJECT_STORAGE_PUBLIC_ENDPOINT=https://<STORAGE_DOMAIN>`. Configure real passwords and demo tokens before starting services.

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
docker compose exec api node dist/scripts/seed.js
```

Caddy terminates HTTPS for the API and S3. PostgreSQL, MinIO console and direct API ports bind to loopback; only Caddy publishes 80/443 publicly. S3 signed URLs remain authenticated and the bucket remains private. DNS and reachable ports 80/443 are required for certificates. Database, objects and certificates have persistent Docker volumes. Protect volume backups and the `.env` file. Stop without `-v` to retain data.

## Operations

The worker retries external failures with exponential backoff, caps at five minutes and marks a job `BLOCKED` after ten attempts. Inspect `GET /v1/operator/jobs` using the operator token; retry with `POST /v1/operator/jobs/{jobId}/retry`, `{}` and a fresh `Idempotency-Key`. Replays preserve economic transaction IDs and signed bytes. A conclusively failed or expired transaction is not replaced automatically; a retry cannot repair it. Inspect the ledger and database before an operator recovery. The service never marks uncertain payments as paid.

An `APPROVED` task can be awaiting HCS publication or reward confirmation. `PAID` can be awaiting the `RewardPaid` audit message. `pending_indexing` means Mirror Node has not exposed the relevant records. These are distinct states, not failures to hide. Monitor blocked jobs, worker logs, operator balance and `/health/ready`; the readiness endpoint checks DB/storage, not Hedera availability.

The operator account must be dedicated to this demo. Reservations serialize task allocation and reward submission, but cannot prevent an external wallet from spending the same account's funds. `HEDERA_FEE_RESERVE_HBAR` is a configurable balance margin, not an escrow or fee estimate guarantee. Keep the operator funded and use testnet only.

See [x402 setup and recovery](docs/x402.md), [architecture](ARCHITECTURE.md), [security](SECURITY.md), and [privacy](PRIVACY.md).

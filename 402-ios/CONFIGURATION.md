# Local configuration

`AppConfiguration` reads local overrides from the process environment and falls back to values in the app's `Info.plist`.

To configure the app in Xcode:

1. Open **Product > Scheme > Edit Scheme**.
2. Select **Run > Arguments**.
3. Under **Environment Variables**, add `FIELDPROOF_API_BASE_URL` and `WORKER_API_TOKEN`.
4. Set its value to the backend origin, for example `http://127.0.0.1:3000`.
5. Set `WORKER_API_TOKEN` to the worker bearer token issued by the backend.
6. Optionally add `FIELDPROOF_WORKER_ID` to override the development worker ID.

Keep the `WORKER_API_TOKEN` value empty in `.env.example`. Do not add bearer tokens or other secrets to `Info.plist`, source control, or a shared scheme. Use an unshared local scheme for development; production session credentials should be stored in Keychain.

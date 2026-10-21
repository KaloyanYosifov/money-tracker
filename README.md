# Money Tracker

An offline-first money tracker for iPhone, iPad and the browser. The data syncs to a self-hosted backend.

## Parts of the repo

| Path | Contents |
|---|---|
| `app/` | Expo (React Native) app for iOS and the web |
| `api/` | Go API: login, TOTP, JWT and JWKS, upload of changes to PostgreSQL |
| `schema/` | JSON Schemas for the synced records, and the code generator for TypeScript and Go types |
| `sync/` | PowerSync sync rules |
| `e2e/` | End-to-end tests: Playwright (web), Maestro (iOS) and cross-app scenarios |
| `deploy/docker/` | Dockerfiles and the nginx config for the web image |
| `deploy/compose/` | Local stack: PostgreSQL, PowerSync, API and Toxiproxy |
| `docs/` | Plans and operations notes |

## Commands

| Command | What it does |
|---|---|
| `make generate` | Generates `app/src/generated/schema.ts` and `api/internal/schema/types_gen.go` from `schema/` |
| `make check-generated` | Runs `make generate`, then fails if the generated files differ from the committed files |
| `make test-api` | Runs the Go tests (`go -C api test ./...`) |
| `make test-app` | Runs the app tests (`npm --workspace app test`) |
| `make test` | Runs `test-api` and `test-app` |
| `make stack-up` | Builds and starts the local stack with Docker Compose, and waits until it is healthy |
| `DISABLE_TOTP=true make stack-up` | Starts the local stack with no TOTP step at login and invite setup. Only for manual tests: the e2e suites need TOTP, and the API refuses the flag unless `PUBLIC_URL` is a localhost URL |
| `make stack-down` | Stops the local stack and deletes its volumes |
| `make e2e-stack-up` | Starts the e2e stack: a second Compose project (`money-tracker-e2e`) with its own database, on the dev ports plus 10000 (API 28080, PowerSync 28081, web 28088). The e2e suites use only this stack and delete its data before they run, so the dev data stays |
| `make e2e-stack-down` | Stops the e2e stack and deletes its volumes |
| `make e2e-web` | Runs the Playwright web suite (`npm --workspace e2e run test:web`) against the e2e stack |
| `make e2e-ios` | Runs the Maestro iOS suite against the e2e stack, on the `IOS_PHONE_SIMULATOR` (default "iPhone 17e") and `IOS_TABLET_SIMULATOR` (default "iPad (A16)") simulators, so the dev simulators keep their dev build |
| `make e2e-cross` | Runs the cross-app scenarios (web and iOS) against the e2e stack |

The npm scripts `npm run generate` and `npm run check-generated` do the same as the `make` targets.

## Requirements

- Node.js 24 (LTS) and npm
- Go 1.25 or newer
- Docker with Compose, for the local stack and the e2e tests
- Xcode and a development build (`npx expo run:ios`) for iOS. Expo Go does not work.

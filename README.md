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
| `make stack-down` | Stops the local stack and deletes its volumes |
| `make e2e-web` | Runs the Playwright web suite (`npm --workspace e2e run test:web`) |

The npm scripts `npm run generate` and `npm run check-generated` do the same as the `make` targets.

## Requirements

- Node.js 24 (LTS) and npm
- Go 1.25 or newer
- Docker with Compose, for the local stack and the e2e tests
- Xcode and a development build (`npx expo run:ios`) for iOS. Expo Go does not work.

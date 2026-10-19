# Money Tracker Core App and Sync Implementation Plan

**Goal:** Build the offline-first money tracker (iPhone, iPad and browser) with self-hosted sync to the home cluster, with a UI that copies Spending Tracker.

**Architecture:** One Expo (React Native) TypeScript app runs on iOS and the web. It reads and writes only a local SQLite database that PowerSync keeps in sync. A Go API handles login (password plus mandatory TOTP), issues EdDSA JWTs that PowerSync checks through JWKS, and validates and applies uploads to PostgreSQL. PowerSync (self-hosted) streams PostgreSQL changes back to the devices, filtered per user. JSON Schema files are the single source for the record types in TypeScript and Go. Production runs on the home k3s cluster through the `deploy.sh` engine in `home-infrastructure`, with a CloudNativePG database on `longhorn-encrypted` storage.

**Tech Stack:** Expo SDK (latest stable), Expo Router, React Native, react-native-svg, PowerSync (`@powersync/react-native`, `@powersync/op-sqlite` with SQLCipher, `@powersync/web`, `@powersync/react`), Jest, better-sqlite3 (query tests), Go (latest stable, 1.25 or newer) with `net/http`, pgx v5, goose, golang-jwt v5, `golang.org/x/crypto/argon2`, pquerna/otp, santhosh-tekuri/jsonschema v6, testcontainers-go, PostgreSQL 17, PowerSync service image `journeyapps/powersync-service`, Toxiproxy, Playwright, Maestro, GitHub Actions, CloudNativePG, Longhorn, SOPS (age), NGINX Gateway Fabric and ingress-nginx.

---

## Context and agreed design

This plan covers part 1 and part 2 of the product spec (`expense-tracker-spec.md`): the core app and sync. CSV import, export and restore, salary planning, AI suggestions and bank connections get their own plans later.

Product rules:

- Platforms: iPhone and iPad (React Native through Expo) and a browser version. No Android app and no desktop app.
- UI: copies Spending Tracker. Spending (chalkboard summary), Transactions (cream list), Categories, Accounts, Settings from the ⋮ menu. On the phone, landscape on Spending or Transactions shows Reports (Categories pie and Cash Flow line chart). The browser shows one page at a time with a left sidebar (pages, quick-add buttons, sync state, user) and a Reports page. Below 900 px the browser uses the phone layout.
- Accounts are places for money (Wallet, N26, Revolut). They are not logins. A transfer moves money between two accounts and is never income or expense. Carry Over is computed, never stored.
- Users: one login user now, separate users from day one, invite only. Each user sees only their own data.
- One currency per user. Each transaction still stores `currency_code`.
- Security: Argon2id passwords, mandatory TOTP at login only, recovery codes, access JWT for 10 minutes, rotating refresh tokens with reuse detection, revocable per device. iOS keeps the refresh token in the Keychain (`expo-secure-store`). The web keeps it in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Optional Face ID or Touch ID app lock per device. SQLCipher on iOS. The browser database is not encrypted, and logout deletes it.
- Sync: UUIDs made on the device, upserts by UUID (safe to retry), amounts as integer minor units, dates as `YYYY-MM-DD` without time zone, last write wins per field (the API writes only the changed fields), delete wins over edit (table `deleted_records`), repeating occurrences use UUIDv5 from the rule ID and the date.
- Errors: five sync states (Synced, Syncing, Offline, Needs attention, Log in again). A permanent rejection leaves the queue and goes to a local `sync_problems` table. Undo for deletes delays the real delete for 5 seconds. Uploads carry a schema version. The API accepts the current and the previous version and returns 426 for older ones.

Verified facts about `home-infrastructure` (read on 2026-10-19):

- Single-node k3s on arm64 (Raspberry Pi class, Debian). All images must exist for `linux/arm64`.
- Deploys use `./deploy.sh <app> <install|upgrade|uninstall>` with `k8s/<app>/app.conf` (see `docs/deploy.md`). Plain manifest apps set `NEEDS_HELM=false` and list files in `MANIFESTS`. SOPS-encrypted secrets go in `k8s/<app>/secrets/` (`SECRETS_DIR=secrets`). The `.sops.yaml` rule for `k8s/.*/secrets/.*\.ya?ml$` already exists.
- `k8s/bookero` is the reference app: a backend, an nginx frontend that proxies `/api` to the backend, a namespace file with a `LimitRange`, restricted pod `securityContext`, both an `Ingress` (ingress-nginx, `cert-manager.io/cluster-issuer: letsencrypt`) and an `HTTPRoute` plus `ReferenceGrant` for the NGF shared gateway, with a per-host listener in `k8s/nginx-gateway-fabric/gateway.yaml` on temporary port 8443. Images are on Docker Hub as `kyosifov/<name>:<tag>`, and the tag is bumped by hand in the manifest.
- The CloudNativePG operator runs out of repo (helm release `cnpg`, namespace `homedb-operator`). No app in the repo has a CNPG `Cluster` yet.
- `longhorn-encrypted` is the default StorageClass (LUKS, key in `longhorn-crypto`). The Longhorn `RecurringJob` `daily-backup` backs up every volume to S3 at 02:00 and keeps 14. Backups of encrypted volumes are ciphertext.
- `k8s/prometheus/alerts.yaml` has only the `FailingPods` rule. No rule alerts on failed Jobs.
- The pod CIDR is the k3s default `10.42.0.0/16`.

Constraints and risks:

- **RISK: PowerSync on Expo web.** The web SDK needs wa-sqlite assets and workers. Task 25 is a spike that proves PowerSync on both the iOS dev build and Expo web before any UI work. If the web part fails, stop and report. Do not build the UI on a broken base.
- **RISK: arm64 images.** Task 19 checks that `journeyapps/powersync-service` publishes `linux/arm64`. If it does not, stop and report.
- **RISK: GitHub-hosted macOS runners have no Docker.** The iOS and cross-app e2e suites need the Compose stack, so they run on a self-hosted macOS runner (your Mac with Docker Desktop and Xcode).
- **CONSTRAINT: Expo Go does not work.** PowerSync uses native SQLite, so iOS work needs a development build (`npx expo run:ios`).
- **CONSTRAINT: auth tables never sync.** The PostgreSQL publication and the PowerSync role grants cover only the six synced tables. `users`, `invites`, `recovery_codes`, `refresh_tokens` and `deleted_records` are invisible to PowerSync.

Hostnames (change them in one place, Task 49, if you want others): `money.kyosifov.com` serves the web app and `/api`. `money-sync.kyosifov.com` serves PowerSync.

## File structure

This repo (`money-tracker`):

| Path | Responsibility |
|---|---|
| `package.json`, `package-lock.json` | npm workspaces: `app`, `e2e` |
| `Makefile` | `generate`, `check-generated`, `test`, `stack-up`, `stack-down`, `e2e-web` |
| `schema/*.schema.json` | One JSON Schema per synced record, plus `upload.schema.json` and `version.json` |
| `schema/scripts/generate.mjs` | Generates `app/src/generated/schema.ts` and `api/internal/schema/types_gen.go` |
| `sync/sync-rules.yaml` | PowerSync sync rules (baked into our PowerSync image) |
| `api/cmd/mtapi/main.go` | Subcommands `serve`, `migrate`, `admin` |
| `api/internal/config/` | Environment config and validation |
| `api/internal/db/` | pgx pool, goose migrations (`migrations/*.sql`) |
| `api/internal/auth/` | Passwords, TOTP, secret encryption, JWT and JWKS, refresh tokens, rate limits, auth handlers, middleware |
| `api/internal/users/` | Users, invites, default data seeding |
| `api/internal/sync/` | Upload validation and apply logic, upload handler |
| `api/internal/schema/` | Generated Go types, embedded JSON Schemas, validator |
| `api/internal/httpserver/` | Router, security headers, health, body limits |
| `api/internal/testutil/` | testcontainers PostgreSQL helper |
| `app/` | Expo app (see Task 20 for the layout inside) |
| `e2e/web/` | Playwright web suite |
| `e2e/ios/` | Maestro runner (TOTP codes, Toxiproxy, Face ID events) |
| `e2e/cross/` | Cross-app scenarios |
| `e2e/support/` | Shared helpers: stack control, users, TOTP, Toxiproxy |
| `app/e2e/maestro/*.yaml` | Maestro flows |
| `deploy/docker/` | `api.Dockerfile`, `web.Dockerfile`, `web-nginx.conf.template`, `powersync.Dockerfile` |
| `deploy/compose/` | `docker-compose.yml`, `powersync.yaml`, `postgres-init.sql`, `toxiproxy.json` |
| `.github/workflows/` | `ci.yml`, `ios-e2e.yml`, `release.yml` |
| `docs/operations.md` | Invite a user, reset TOTP, revoke sessions, rotate keys, restore, release |

Infra repo (`home-infrastructure`):

| Path | Responsibility |
|---|---|
| `home-infrastructure/k8s/money-tracker/app.conf` | Deploy engine config |
| `home-infrastructure/k8s/money-tracker/namespace.yaml` | Namespace, labels, LimitRange |
| `home-infrastructure/k8s/money-tracker/postgres.yaml` | CNPG `Cluster` and `Database` |
| `home-infrastructure/k8s/money-tracker/api.yaml` | API Deployment (with migrate init container) and Service |
| `home-infrastructure/k8s/money-tracker/powersync.yaml` | PowerSync Deployment and Service |
| `home-infrastructure/k8s/money-tracker/web.yaml` | Web Deployment and Service |
| `home-infrastructure/k8s/money-tracker/network-policy.yaml` | Default deny ingress plus allow rules |
| `home-infrastructure/k8s/money-tracker/ingress.yaml`, `httproute.yaml`, `gateway-referencegrant.yaml`, `snippetsfilter.yaml` | Edge routing for both hosts |
| `home-infrastructure/k8s/money-tracker/backup-jobs.yaml` | Nightly `pg_dump`, monthly restore check, dump PVC |
| `home-infrastructure/k8s/money-tracker/secrets/money-tracker-secrets.yaml` | SOPS-encrypted secrets |
| `home-infrastructure/k8s/nginx-gateway-fabric/gateway.yaml` | Two new HTTPS listeners |
| `home-infrastructure/k8s/prometheus/alerts.yaml` | New `KubeJobFailed` rule |

---

## Phase 0: Repo foundation

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `.editorconfig`, `Makefile`, `README.md`
- Type: both

- [ ] **Step 1: Create the root files**

In `package.json`, declare a private npm workspace with members `app` and `e2e`, and the scripts `generate` (runs `node schema/scripts/generate.mjs`) and `check-generated`. Pin `engines.node` to the current LTS. In `.gitignore`, ignore `node_modules/`, `dist/`, `.expo/`, `ios/`, `app/ios/`, `api/bin/`, `*.secret.plaintext.yaml`, `.env*`, `e2e/test-results/` and `e2e/playwright-report/`. In `Makefile`, add the targets `generate`, `check-generated`, `test-api` (`go -C api test ./...`), `test-app` (`npm --workspace app test`), `test` (both), `stack-up` (`docker compose -f deploy/compose/docker-compose.yml up -d --build --wait`), `stack-down` (`docker compose -f deploy/compose/docker-compose.yml down -v`) and `e2e-web` (`npm --workspace e2e run test:web`). In `README.md`, describe the parts of the repo and the commands above.

- [ ] **Step 2: Verify**

Run: `make -n test`
Expected: prints the two test commands and exits 0.

### Task 2: JSON Schemas for the synced records

**Files:**
- Create: `schema/version.json`, `schema/account.schema.json`, `schema/category.schema.json`, `schema/transaction.schema.json`, `schema/recurring_rule.schema.json`, `schema/budget.schema.json`, `schema/user_settings.schema.json`, `schema/upload.schema.json`
- Type: both

- [ ] **Step 1: Write the schemas**

Use JSON Schema draft 2020-12. Each record schema sets `additionalProperties: false` and has `id` and `user_id` as UUID strings (`format: uuid`). Rules for all fields:

- `version.json`: `{ "schemaVersion": 1, "minSupportedSchemaVersion": 1 }`.
- `account`: `name` (string, 1 to 60 chars), `color` (string, pattern `^#[0-9a-fA-F]{6}$`), `sort_order` (integer, 0 or more), `archived_at` (date-time string or null).
- `category`: `type` (enum `expense`, `income`), `name` (1 to 60 chars), `icon` (string, 1 to 40 chars, a key from the icon registry), `color` (as account), `sort_order`, `archived_at`.
- `transaction`: `type` (enum `expense`, `income`, `transfer`), `amount_minor` (integer, 1 to 1000000000000), `currency_code` (pattern `^[A-Z]{3}$`), `date` (pattern `^\d{4}-\d{2}-\d{2}$`), `name` (0 to 120 chars), `category_id` (UUID or null), `account_id` (UUID), `to_account_id` (UUID or null), `note` (0 to 2000 chars, or null), `recurring_rule_id` (UUID or null), `source` (enum `manual`, `recurring`, `import`, `bank`), `import_batch_id` (UUID or null), `external_id` (0 to 200 chars, or null), `created_at` and `updated_at` (date-time strings, read only, the server sets them).
- `recurring_rule`: `type`, `amount_minor`, `name`, `category_id`, `account_id`, `to_account_id`, `note` as in `transaction`, plus `frequency` (enum `daily`, `weekly`, `biweekly`, `monthly`, `yearly`), `start_date` and `end_date` (date pattern, `end_date` may be null).
- `budget`: `category_id` (UUID or null, null means the overall budget), `period` (same enum as `time_period` below), `amount_minor` (integer, 1 or more).
- `user_settings`: `currency_code`, `time_period` (enum `daily`, `weekly`, `biweekly`, `monthly`, `yearly`), `week_start_day` (0 to 6, 0 is Sunday), `month_start_day` (1 to 28), `year_start_month` (1 to 12), `budget_mode`, `carry_over`, `hide_future`, `show_note` (booleans), `theme` (enum `light`, `dark`, `system`), `summary_font` (enum `mono`, `system`), `icon_style` (enum `filled`, `outline`).
- `upload.schema.json`: `schema_version` (integer), `ops` (array, 1 to 200 items). Each op has `op` (enum `PUT`, `PATCH`, `DELETE`), `table` (enum of the six table names), `id` (UUID) and optional `data` (object). `data` is required for `PUT` and `PATCH`.

- [ ] **Step 2: Verify the schemas parse**

Run: `npx --yes ajv-cli@5 compile --spec=draft2020 -c ajv-formats -s "schema/*.schema.json"`
Expected: each file prints "schema ... is valid".

### Task 3: Code generation and the drift check

**Files:**
- Create: `schema/scripts/generate.mjs`, `schema/scripts/package.json`
- Create (generated): `app/src/generated/schema.ts`, `api/internal/schema/types_gen.go`
- Modify: `Makefile`, `package.json`
- Type: both

- [ ] **Step 1: Write the generator**

`generate.mjs` reads every `schema/*.schema.json` and `schema/version.json`. For TypeScript, it uses `json-schema-to-typescript` to write one exported type per record (`Account`, `Category`, `Transaction`, `RecurringRule`, `Budget`, `UserSettings`, `UploadRequest`) plus the constants `SCHEMA_VERSION` and `MIN_SUPPORTED_SCHEMA_VERSION` into `app/src/generated/schema.ts`. For Go, it runs `go run github.com/atombender/go-jsonschema@<pinned version>` with package name `schema` into `api/internal/schema/types_gen.go`, then appends the two constants. Both outputs start with a "generated, do not edit" header. Pin all generator versions in `schema/scripts/package.json`.

- [ ] **Step 2: Add the check**

`make check-generated` runs `make generate` and then `git diff --exit-code app/src/generated api/internal/schema/types_gen.go`. It fails if the committed files differ from fresh output.

- [ ] **Step 3: Verify**

Run: `make generate && make check-generated`
Expected: both exit 0. A manual edit to `app/src/generated/schema.ts` makes `make check-generated` exit non-zero.

---

## Phase 1: Go API

### Task 4: Go module, config and HTTP server shell

**Files:**
- Create: `api/go.mod`, `api/cmd/mtapi/main.go`, `api/internal/config/config.go`, `api/internal/config/config_test.go`, `api/internal/httpserver/server.go`, `api/internal/httpserver/server_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

In `config_test.go`, add `TestLoadRequiresAllSettings`: with an empty environment, `config.Load` returns an error that names every missing variable. Add `TestLoadParsesValidEnv`: with all variables set, it returns a config with the parsed values. Variables: `DATABASE_URL`, `LISTEN_ADDR` (default `:8080`), `PUBLIC_URL`, `JWT_PRIVATE_KEY_PEM` (Ed25519 PKCS#8 PEM), `JWT_ISSUER`, `TOTP_ENC_KEY` (base64 of exactly 32 bytes, else error), `COOKIE_SECURE` (default `true`), `TRUSTED_PROXY_CIDRS` (comma list, default empty), `CORS_ORIGINS` (comma list, default empty).

In `server_test.go`, add `TestHealthz` (GET `/healthz` returns 200 with body `ok`), `TestSecurityHeaders` (every response has `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`), `TestBodyLimit` (a 2 MB POST to any route returns 413) and `TestCORS` (an `Origin` in `CORS_ORIGINS` gets `Access-Control-Allow-Origin` with credentials. Any other origin gets no CORS headers).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/config/... ./internal/httpserver/...`
Expected: FAIL, the packages do not compile yet.

- [ ] **Step 3: Implement**

`config.Load` reads and validates the environment as described. `httpserver.New` builds a `net/http` `ServeMux` (Go 1.22 method patterns), wraps it in middleware for the security headers, a 1 MB body limit (`http.MaxBytesReader`), CORS for the configured origins only, and structured request logs with `log/slog` that never log headers or bodies. The `http.Server` sets `ReadHeaderTimeout` 5 s, `ReadTimeout` 15 s, `WriteTimeout` 30 s and `IdleTimeout` 60 s. `main.go` dispatches the subcommands `serve`, `migrate` and `admin`. Only `serve` works in this task.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/config/... ./internal/httpserver/...`
Expected: PASS

### Task 5: Database migrations and the test database helper

**Files:**
- Create: `api/internal/db/db.go`, `api/internal/db/migrate.go`, `api/internal/db/migrations/00001_core.sql`, `api/internal/db/migrations/00002_auth.sql`, `api/internal/db/migrations/00003_sync_access.sql`, `api/internal/db/migrate_test.go`, `api/internal/testutil/pg.go`
- Modify: `api/cmd/mtapi/main.go`
- Type: backend

- [ ] **Step 1: Write the failing test**

`testutil.StartPostgres(t)` starts `postgres:17` with testcontainers-go, creates the role `powersync_repl` (LOGIN, REPLICATION), runs all migrations and returns a pgx pool. Postgres must start with `wal_level=logical`. In `migrate_test.go`, add `TestMigrationsCreateSchema`: the six synced tables, `users`, `invites`, `recovery_codes`, `refresh_tokens` and `deleted_records` exist. The publication `powersync` lists exactly the six synced tables. `powersync_repl` has SELECT on the six synced tables and no privilege on `users`, `invites`, `recovery_codes` or `refresh_tokens`. Add `TestMigrationsAreIdempotent`: a second migrate run is a no-op.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go -C api test ./internal/db/...`
Expected: FAIL, migrations missing.

- [ ] **Step 3: Write the migrations**

Use goose SQL migrations embedded with `embed.FS`.

`00001_core.sql` creates the six synced tables with the columns from the JSON Schemas. All IDs are `uuid`, `user_id uuid NOT NULL`, amounts `bigint`, dates `date`, timestamps `timestamptz`. `created_at` and `updated_at` default to `now()`. Each table has `UNIQUE (user_id, id)`. References use composite foreign keys so a row can only point to rows of the same user: `transactions (user_id, account_id)`, `(user_id, to_account_id)` to `accounts (user_id, id)`, and `(user_id, category_id)` to `categories (user_id, id)`, with `ON DELETE RESTRICT`. `recurring_rules` and `budgets` use the same pattern. `transactions.recurring_rule_id` uses `ON DELETE SET NULL` on the composite key, with only that column set to null. `user_settings` has `UNIQUE (user_id)`. Checks: `amount_minor > 0`; for `transfer`, `category_id IS NULL AND to_account_id IS NOT NULL AND to_account_id <> account_id`; for `expense` and `income`, `category_id IS NOT NULL AND to_account_id IS NULL`. Indexes: `transactions (user_id, date)`, `transactions (user_id, category_id)`, `transactions (user_id, account_id)`.

`00002_auth.sql` creates:
- `users`: `id uuid PK`, `email citext UNIQUE`, `password_hash text`, `totp_secret_enc bytea`, `totp_enabled boolean DEFAULT false`, `totp_last_step bigint`, `role text CHECK (role IN ('admin','user'))`, `failed_logins int DEFAULT 0`, `locked_until timestamptz`, `created_at`.
- `invites`: `token_hash bytea PK`, `email`, `currency_code`, `role`, `expires_at`, `used_at`.
- `recovery_codes`: `user_id`, `code_hash bytea`, `used_at`.
- `refresh_tokens`: `id uuid PK`, `user_id`, `family_id uuid`, `token_hash bytea UNIQUE`, `device_name text`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `replaced_by uuid`.
- `deleted_records`: `table_name text`, `id uuid`, `user_id uuid`, `deleted_at`, with `PK (table_name, id)`.

`00003_sync_access.sql` runs `CREATE PUBLICATION powersync FOR TABLE` on the six synced tables and `GRANT SELECT` on those six tables to `powersync_repl`. If the role does not exist, the migration fails with a clear message.

`db.Migrate(ctx, url)` runs goose up. `mtapi migrate` calls it and exits.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go -C api test ./internal/db/...`
Expected: PASS

### Task 6: Password hashing

**Files:**
- Create: `api/internal/auth/password.go`, `api/internal/auth/password_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestHashAndVerifyPassword`: `HashPassword("correct horse")` returns a PHC string that starts with `$argon2id$v=19$`. `VerifyPassword` returns true for the same password and false for another. `TestHashesDiffer`: two hashes of one password differ (random salt). `TestRejectShortPassword`: `HashPassword` returns `ErrPasswordTooShort` for fewer than 12 characters. `TestVerifyIsConstantTimeForBadHash`: a malformed hash returns false and no panic.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ -run Password`
Expected: FAIL

- [ ] **Step 3: Implement**

Argon2id with memory 64 MiB, time 3, parallelism 2, 16-byte salt from `crypto/rand`, 32-byte key, PHC encoding. Compare with `subtle.ConstantTimeCompare`. These settings take about 0.5 s on a Raspberry Pi 4 class CPU. If a login takes longer than 1 s on the cluster, lower the memory to 46 MiB and record the change in `docs/operations.md`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ -run Password`
Expected: PASS

### Task 7: Secret encryption for TOTP secrets

**Files:**
- Create: `api/internal/auth/secretbox.go`, `api/internal/auth/secretbox_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestSealOpenRoundTrip`: `Open(key, Seal(key, plaintext, userID), userID)` returns the plaintext. `TestOpenFailsWithOtherUserID`: the user ID is the associated data, so another ID fails. `TestOpenFailsWithTamperedCiphertext`. `TestSealIsRandomized`: two seals of the same input differ.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ -run Seal`
Expected: FAIL

- [ ] **Step 3: Implement**

AES-256-GCM. The 12-byte random nonce goes in front of the ciphertext. The key comes from `TOTP_ENC_KEY`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ -run Seal`
Expected: PASS

### Task 8: TOTP and recovery codes

**Files:**
- Create: `api/internal/auth/totp.go`, `api/internal/auth/totp_test.go`, `api/internal/auth/recovery.go`, `api/internal/auth/recovery_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

TOTP tests use a fixed clock. `TestNewTOTPSecret` returns a base32 secret and an `otpauth://totp/Money%20Tracker:<email>?secret=...&issuer=Money%20Tracker` URL. `TestVerifyCurrentStep`, `TestVerifyAcceptsOneStepDrift` (plus and minus 30 s), `TestVerifyRejectsTwoStepsDrift`, and `TestVerifyRejectsReplay`: `Verify(secret, code, now, lastStep)` returns the matched step, and a code whose step is at or below `lastStep` fails.

Recovery tests: `TestGenerateRecoveryCodes` returns 10 codes in the format `xxxxx-xxxxx` (lowercase base32, no ambiguous letters) and 10 SHA-256 hashes. `TestRecoveryCodeMatchIgnoresCaseAndDash`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ -run 'TOTP|Recovery'`
Expected: FAIL

- [ ] **Step 3: Implement**

Use `github.com/pquerna/otp/totp` with SHA1, 6 digits, period 30. Compute the step yourself to return it and to apply the replay rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ -run 'TOTP|Recovery'`
Expected: PASS

### Task 9: JWT signing and JWKS

**Files:**
- Create: `api/internal/auth/tokens.go`, `api/internal/auth/tokens_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestIssueAccessToken`: the token is EdDSA-signed, has header `kid`, claims `iss` (config issuer), `sub` (user ID), `aud` `["mt-api","mt-powersync"]`, `iat`, and `exp` 10 minutes later. `TestParseAccessTokenRejects` covers: wrong signature, expired, wrong `aud`, `alg: none`, and an MFA token used as an access token. `TestIssueMFAToken`: `aud` is `["mt-mfa"]`, lifetime 5 minutes. `TestJWKS`: `JWKS()` returns a JSON document with one OKP key (`crv: Ed25519`), the same `kid`, `use: sig`, `alg: EdDSA`, and no private part.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ -run 'Token|JWKS'`
Expected: FAIL

- [ ] **Step 3: Implement**

Use `github.com/golang-jwt/jwt/v5` with `jwt.SigningMethodEdDSA`. The parser allows only EdDSA and checks `iss`, `aud` and `exp`. `kid` is the base64url SHA-256 of the public key, first 16 characters.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ -run 'Token|JWKS'`
Expected: PASS

### Task 10: Refresh token store

**Files:**
- Create: `api/internal/auth/refresh.go`, `api/internal/auth/refresh_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

These are integration tests with `testutil.StartPostgres`. `TestCreateAndRotate`: `Create(userID, deviceName)` returns a 32-byte random token (base64url). `Rotate(token)` returns a new token for the same user and family, and marks the old row revoked with `replaced_by` set. `TestReuseRevokesFamily`: using a token that was already rotated revokes every token in the family and returns `ErrTokenReused`. `TestExpiry`: tokens expire 90 days after the last use, and `Rotate` of an expired token returns `ErrTokenExpired`. `TestRevokeSession` and `TestRevokeAllForUser`. `TestListSessions` returns the device name, created and last-used times, and a flag for the current session.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ -run Refresh`
Expected: FAIL

- [ ] **Step 3: Implement**

Store only the SHA-256 of each token. Rotation runs in one transaction with `SELECT ... FOR UPDATE` on the old row. Each rotation sets `expires_at` to now plus 90 days.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ -run Refresh`
Expected: PASS

### Task 11: Rate limits, lockout and client IP

**Files:**
- Create: `api/internal/auth/ratelimit.go`, `api/internal/auth/ratelimit_test.go`, `api/internal/httpserver/clientip.go`, `api/internal/httpserver/clientip_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestIPLimiter`: with a fake clock, 10 login attempts per minute per IP pass and the 11th fails. The bucket refills after a minute. `TestUserLockout` (database test): 5 failed password checks set `locked_until` to now plus 15 minutes. A correct password during the lock still fails with `ErrLocked`. A success resets `failed_logins`. The same rule counts TOTP failures for the user. `TestClientIP`: `X-Real-IP` and the last `X-Forwarded-For` hop are trusted only when the remote address is in `TRUSTED_PROXY_CIDRS`. Otherwise the remote address is used.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ ./internal/httpserver/ -run 'Limiter|Lockout|ClientIP'`
Expected: FAIL

- [ ] **Step 3: Implement**

The IP limiter uses `golang.org/x/time/rate`, one limiter per IP in a map with cleanup of idle entries every 10 minutes. This is enough, because the API runs as one replica. The lockout state lives in `users`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ ./internal/httpserver/ -run 'Limiter|Lockout|ClientIP'`
Expected: PASS

### Task 12: Users, invites, seeding and the admin commands

**Files:**
- Create: `api/internal/users/store.go`, `api/internal/users/store_test.go`, `api/internal/users/seed.go`, `api/internal/users/seed_test.go`, `api/cmd/mtapi/admin.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

Database tests. `TestCreateInvite` returns a 32-byte random token. Only its hash is stored, it expires after 72 hours, and it carries email, currency and role. `TestAcceptInviteRejectsExpiredOrUsed`. `TestSeedDefaults`: `SeedDefaults(tx, userID, currency)` creates one `user_settings` row (defaults: `time_period` monthly, `week_start_day` 1, `month_start_day` 1, `year_start_month` 1, `budget_mode` false, `carry_over` true, `hide_future` false, `show_note` true, `theme` system, `summary_font` mono, `icon_style` filled), the expense categories Eating Out, Shopping, Groceries, Entertainment, Travel, Service, Tax, Gifts, Rent, Bills, Education and General, the income categories Salary and Other income (each with an icon key and colour from Task 31), and the accounts Wallet and Bank. A second call does nothing. `TestResetTOTP` clears the secret, sets `totp_enabled` false, deletes recovery codes, revokes all refresh tokens and returns a new invite token for the same user.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/users/...`
Expected: FAIL

- [ ] **Step 3: Implement**

Implement the store and seeding, then the admin subcommands:
- `mtapi admin invite --email <e> --currency <ISO> [--role admin|user]` prints `<PUBLIC_URL>/invite?token=<token>`.
- `mtapi admin reset-totp --email <e>` prints a new invite URL. The user sets a new password and TOTP.
- `mtapi admin revoke-sessions --email <e>`.

The commands read `DATABASE_URL` and `PUBLIC_URL` only.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/users/...`
Expected: PASS

### Task 13: Auth HTTP handlers

**Files:**
- Create: `api/internal/auth/handlers.go`, `api/internal/auth/handlers_test.go`
- Modify: `api/internal/httpserver/server.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

These are HTTP tests against a real database. Each test name states its case:

- `TestInviteAccept`: `POST /api/auth/invite/accept {token, password}` checks the invite, creates the user with the password hash and an encrypted pending TOTP secret, and returns `{otpauth_url, secret}`. The invite is not used yet. A second accept with the same token replaces the pending secret.
- `TestInviteConfirm`: `POST /api/auth/invite/confirm {token, code, device_name}` with a correct code sets `totp_enabled`, marks the invite used, seeds the defaults (Task 12), and returns the token response plus `recovery_codes` (10 codes, shown once). A wrong code returns 400 `invalid_code`.
- `TestLoginStepOne`: `POST /api/auth/login {email, password}` returns `{mfa_token}` for a correct password. A wrong password or an unknown email returns the same 401 `invalid_credentials` after the same work (hash a dummy password for unknown emails). A user without TOTP returns 403 `setup_incomplete`. A locked user returns 429 `locked`.
- `TestLoginStepTwo`: `POST /api/auth/login/totp {mfa_token, code | recovery_code, device_name}` returns the token response. A replayed code fails. A used recovery code fails, and a fresh one works once.
- `TestTokenResponseNative`: with header `X-Client: native`, the body has `access_token`, `expires_in`, `user_id` and `refresh_token`, and there is no cookie.
- `TestTokenResponseWeb`: without that header, the body has no `refresh_token`. The cookie `mt_refresh` is set with `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`, `Max-Age` 90 days, and `Secure` when `COOKIE_SECURE` is true.
- `TestRefresh`: `POST /api/auth/refresh` takes the body `refresh_token` (native) or the cookie (web). The web form requires the header `X-Requested-With: money-tracker`, else 403. The test checks rotation, reuse detection and the 401 `refresh_invalid` response.
- `TestLogout`: `POST /api/auth/logout` revokes the current refresh token and clears the cookie.
- `TestSessions`: `GET /api/auth/sessions` lists sessions, and `DELETE /api/auth/sessions/{id}` revokes one of your own. Another user's session returns 404.
- `TestJWKSRoute`: `GET /api/.well-known/jwks.json` returns the JWKS with `Cache-Control: public, max-age=300`, which overrides the default `no-store`.
- `TestRateLimitedRoutes`: login and refresh routes use the IP limiter.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/auth/ -run Handler`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the handlers with the behaviour above and register them in `server.go`. Errors are JSON `{ "error": "<code>" }`. Never return details that tell whether an email exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/auth/ -run Handler`
Expected: PASS

### Task 14: Auth middleware

**Files:**
- Create: `api/internal/auth/middleware.go`, `api/internal/auth/middleware_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestRequireUser`: a valid `Authorization: Bearer <access>` puts the user ID in the request context. No token, an expired token or an MFA token returns 401 `unauthorized` with `WWW-Authenticate: Bearer`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go -C api test ./internal/auth/ -run RequireUser`
Expected: FAIL

- [ ] **Step 3: Implement**

Implement `RequireUser(next)` and `UserID(ctx)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go -C api test ./internal/auth/ -run RequireUser`
Expected: PASS

### Task 15: Upload validation

**Files:**
- Create: `api/internal/schema/validate.go`, `api/internal/schema/validate_test.go`, `api/internal/schema/embed.go`, `api/internal/sync/tables.go`, `api/internal/sync/tables_test.go`
- Modify: `schema/scripts/generate.mjs` (also copy the schema files to `api/internal/schema/json/` for embedding)
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestValidateFullRecord`: a `PUT` payload for each table passes against its schema. Payloads with an extra property, a wrong enum or a float amount fail with a message that names the field. `TestValidatePatch`: a `PATCH` payload is checked against the same schema without `required`, so a partial object passes, and an unknown property still fails. `TestReadOnlyFields`: `created_at`, `updated_at` and `id` in `data` are dropped before writes. `TestTableWhitelist`: `tables.go` maps the six table names to their column lists, taken from the generated Go types. An unknown table fails.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/schema/... ./internal/sync/ -run 'Validate|ReadOnly|Whitelist'`
Expected: FAIL

- [ ] **Step 3: Implement**

Compile the embedded schemas once at start with `santhosh-tekuri/jsonschema/v6`, with format checks on. For PATCH, compile a copy of each schema with `required` removed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/schema/... ./internal/sync/ -run 'Validate|ReadOnly|Whitelist'`
Expected: PASS

### Task 16: Upload apply rules

**Files:**
- Create: `api/internal/sync/apply.go`, `api/internal/sync/apply_test.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

These are database tests, with two seeded users A and B. Each case is one subtest of `TestApply`:

- `put_inserts`: a `PUT` inserts the row with `user_id` from the token.
- `put_is_idempotent`: the same `PUT` twice gives one row and the same values.
- `put_user_id_mismatch_rejected`: `data.user_id` other than the token user gives the rejection `forbidden`.
- `put_other_users_id_rejected`: a `PUT` with the ID of a row of user B gives `forbidden`, and B's row is unchanged.
- `patch_updates_only_sent_fields`: two `PATCH` ops on different fields both survive.
- `patch_same_field_last_wins`: two `PATCH` ops on the same field, and the later one wins.
- `patch_missing_rejected`: a `PATCH` for an unknown ID gives `not_found`.
- `delete_removes_and_tombstones`: the row is gone and `deleted_records` has `(table, id, user_id)`.
- `delete_wins`: a `PUT` or `PATCH` for a tombstoned ID is ignored without a rejection, and the row does not come back.
- `delete_in_use_rejected`: deleting a category or account that transactions use gives `in_use`, and the row stays.
- `reference_other_user_rejected`: a transaction with B's `account_id` gives `invalid_reference`.
- `category_type_mismatch_rejected`: an expense with an income category gives `invalid_category_type`.
- `transfer_rules`: a transfer with a category, or with the same from and to account, gives `invalid_transfer`.
- `user_settings_rules`: `PUT` and `DELETE` on `user_settings` give `not_allowed`, and `PATCH` works.
- `updated_at_is_server_time`: `updated_at` is set by the server on each write.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/sync/ -run TestApply`
Expected: FAIL

- [ ] **Step 3: Implement**

`ApplyOp(ctx, tx, userID, op)` returns `Applied`, `Ignored` or `Rejected{code, message}`. Build SQL only from whitelisted column names, with values as parameters. `PUT` is `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE <table>.user_id = $user`. If no row comes back, check whether the ID belongs to another user (`forbidden`). Map PostgreSQL errors: foreign key violation on insert or update gives `invalid_reference`, foreign key violation on delete gives `in_use`, check violation gives `invalid_transfer` or `invalid_record`. For the category type rule, query the category type before an expense or income write.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/sync/ -run TestApply`
Expected: PASS

### Task 17: Upload endpoint

**Files:**
- Create: `api/internal/sync/handler.go`, `api/internal/sync/handler_test.go`
- Modify: `api/internal/httpserver/server.go`
- Type: backend

- [ ] **Step 1: Write the failing tests**

`TestUploadBatch`: `POST /api/sync/upload` with a bearer token and three ops, where the second one is invalid. The response is 200 `{ "rejected": [ { "index": 1, "code": "...", "message": "..." } ] }`, and ops 0 and 2 are applied. `TestUploadOldSchema`: `schema_version` below `MIN_SUPPORTED_SCHEMA_VERSION` returns 426 `{ "error": "upgrade_required" }`. `TestUploadMalformed`: a body that fails `upload.schema.json` returns 400. `TestUploadUnauthorized` returns 401. `TestUploadDatabaseDown`: when the pool cannot connect, the endpoint returns 503, so the client retries the whole batch.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C api test ./internal/sync/ -run TestUpload`
Expected: FAIL

- [ ] **Step 3: Implement**

Run the batch in one database transaction. Each op runs inside a savepoint. A rejection rolls back to the savepoint and is added to `rejected`. Any other error rolls back the whole transaction and returns 503. Log only counts (ops, applied, ignored, rejected) and the user ID.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C api test ./internal/sync/ -run TestUpload`
Expected: PASS

---

## Phase 2: Local stack and PowerSync

### Task 18: Container images

**Files:**
- Create: `deploy/docker/api.Dockerfile`, `deploy/docker/powersync.Dockerfile`, `deploy/docker/web.Dockerfile`, `deploy/docker/web-nginx.conf.template`, `.dockerignore`
- Type: both

- [ ] **Step 1: Write the Dockerfiles**

- `api.Dockerfile`: build stage `golang:<version>` with `CGO_ENABLED=0`, `-trimpath`, `-ldflags=-s -w`. It uses `TARGETOS` and `TARGETARCH` for multi-arch. The runtime is `gcr.io/distroless/static-debian12:nonroot` with the binary only. Entrypoint `/mtapi`, default command `serve`.
- `powersync.Dockerfile`: `FROM journeyapps/powersync-service:<pinned version>`, then `COPY sync/sync-rules.yaml /config/sync-rules.yaml`. The service config comes from a mounted secret at run time.
- `web.Dockerfile`: build stage `node:<LTS>` runs `npm ci` and `npx expo export --platform web` in `app/`, plus the PowerSync web asset copy from Task 25. The runtime is `nginxinc/nginx-unprivileged:<pinned>` on port 8080. `web-nginx.conf.template` serves `dist/` with SPA fallback to `index.html`, long cache headers for hashed assets, and `no-cache` for `index.html`. It proxies `/api/` to `${API_UPSTREAM}`, and sets `Content-Security-Policy` (`default-src 'self'; connect-src 'self' ${POWERSYNC_URL} ${POWERSYNC_WS_URL}; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`), `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options` and `Referrer-Policy`. The official nginx image entrypoint fills the template from the environment.

- [ ] **Step 2: Verify**

Run: `docker buildx build --platform linux/arm64,linux/amd64 -f deploy/docker/api.Dockerfile .`
Expected: the build succeeds for both platforms.

### Task 19: Sync rules, Compose stack and Toxiproxy

**Files:**
- Create: `sync/sync-rules.yaml`, `deploy/compose/docker-compose.yml`, `deploy/compose/powersync.yaml`, `deploy/compose/postgres-init.sql`, `deploy/compose/toxiproxy.json`, `deploy/compose/dev.env`
- Type: both

- [ ] **Step 1: Check arm64 support**

Run: `docker buildx imagetools inspect journeyapps/powersync-service:<pinned version>`
Expected: the list shows `linux/arm64`. If it does not, stop and report.

- [ ] **Step 2: Write the files**

`sync-rules.yaml` has one bucket `user_data` with parameter query `SELECT request.user_id() AS user_id` and one data query per synced table: `SELECT * FROM <table> WHERE user_id = bucket.user_id`.

`postgres-init.sql` creates the role `powersync_repl` (LOGIN, REPLICATION, dev password), the role `powersync_storage` and the database `powersync_storage` owned by it.

`powersync.yaml` sets `replication.connections` to one `postgresql` connection to database `money` as `powersync_repl`, `storage` of type `postgresql` to `powersync_storage`, `sync_rules.path: /config/sync-rules.yaml`, and `client_auth.jwks_uri: http://api:8080/api/.well-known/jwks.json` with `audience: ["mt-powersync"]`. Use the `!env` tag for every URI and password, as the PowerSync self-hosting docs describe.

`docker-compose.yml` has the services:
- `postgres` (`postgres:17`, `command: postgres -c wal_level=logical`, init script mounted, health check).
- `api` (built from `api.Dockerfile`). It runs `migrate` and then `serve`, with `dev.env`: a dev Ed25519 key, a dev TOTP key, `COOKIE_SECURE=false`, `PUBLIC_URL=http://localhost:8088` and `CORS_ORIGINS=http://localhost:8081`.
- `powersync` (built from `powersync.Dockerfile`, config mounted).
- `toxiproxy` (`ghcr.io/shopify/toxiproxy`), with `toxiproxy.json` defining `api` (listen `0.0.0.0:18080`, upstream `api:8080`) and `powersync` (listen `0.0.0.0:18081`, upstream `powersync:8080`), ports 8474, 18080 and 18081 published.
- `web` (built from `web.Dockerfile`, `API_UPSTREAM=http://toxiproxy:18080`, `POWERSYNC_URL=http://localhost:18081`, port 8088 published).

Dev keys in `dev.env` are clearly marked as dev-only and never used elsewhere.

- [ ] **Step 3: Verify the stack and the JWKS link**

Run: `make stack-up && docker compose -f deploy/compose/docker-compose.yml exec api /mtapi admin invite --email dev@example.com --currency EUR && curl -fsS http://localhost:18080/api/.well-known/jwks.json && docker compose -f deploy/compose/docker-compose.yml logs powersync | grep -i -E "replication|error"`
Expected: an invite URL prints, the JWKS JSON prints, and the PowerSync logs show the replication start with no errors.

---

## Phase 3: App foundation

### Task 20: Expo app scaffold

**Files:**
- Create: `app/package.json`, `app/app.json`, `app/tsconfig.json`, `app/metro.config.js`, `app/jest.config.js`, `app/eslint.config.js`, `app/app/_layout.tsx`, `app/scripts/generate-textures.mjs`, `app/assets/fonts/DroidSansMono.ttf`, `app/assets/fonts/LICENSE-DroidSansMono.txt`, `app/assets/textures/paper.png`, `app/assets/textures/chalk.png`
- Type: frontend

- [ ] **Step 1: Create the app**

Create a TypeScript Expo app with Expo Router (strict TypeScript). In `app.json`, set `orientation: "default"`, `ios.supportsTablet: true`, `ios.bundleIdentifier: "com.kyosifov.moneytracker"`, `ios.infoPlist.NSFaceIDUsageDescription` ("Unlock Money Tracker with Face ID"), `web.output: "single"` and `web.bundler: "metro"`. Add the dependencies `expo-router`, `expo-font`, `expo-secure-store`, `expo-local-authentication`, `expo-crypto`, `react-native-svg`, `react-native-qrcode-svg`, `uuid` and `@react-native-async-storage/async-storage` with `npx expo install`. Add dev dependencies `jest-expo`, `@testing-library/react-native` and `better-sqlite3`. Droid Sans Mono is Apache 2.0, so ship its licence file. `generate-textures.mjs` uses `pngjs` to write two 256 by 256 tileable noise textures: paper (warm beige `#ece2d1`, low-contrast brown noise) and chalk (`#2a2a2a`, faint white noise). Commit the output PNGs. The root `_layout.tsx` loads the font and renders a placeholder screen for now.

- [ ] **Step 2: Verify**

Run: `npm --workspace app run lint && npm --workspace app test -- --passWithNoTests && npx --workspace app expo export --platform web`
Expected: all three exit 0.

### Task 21: Money helpers

**Files:**
- Create: `app/src/domain/money.ts`, `app/src/domain/money.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`parseAmount("12.34", "EUR")` returns 1234. `parseAmount("12,34", "EUR", "bg-BG")` returns 1234 (the locale decimal separator). `parseAmount("0")`, `parseAmount("-5")` and `parseAmount("abc")` return null. Values above 1000000000000 minor units return null. `formatAmount(9243471, "EUR", "en-IE")` returns `€92,434.71`. `formatAmount` with `signed: true` returns `+€92,434.71` for a positive value. `minorUnits("JPY")` is 0 and `minorUnits("EUR")` is 2. Also test the calculator keypad: `evaluateExpression("12.50+3*2")` returns 1850 minor units, and a division by zero returns null.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/domain/money.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Use `Intl.NumberFormat` for formatting and minor units. Do all arithmetic in integers. The expression evaluator parses `+ - * /` with normal precedence. It does not use `eval` or `Function`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/domain/money.test.ts`
Expected: PASS

### Task 22: Period ranges

**Files:**
- Create: `app/src/domain/period.ts`, `app/src/domain/period.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`periodFor(date, kind, settings)` returns `{ start, end }` as inclusive `YYYY-MM-DD` strings. `shiftPeriod(period, kind, settings, ±1)` returns the next or the previous period. `periodLabel(period, kind, locale)` returns, for example, "October", "October 2026" (when not the current year), "12 – 18 Oct" for weeks, "2026" for years and "Mon, 19 Oct" for days. Cases:

- Weekly with `week_start_day` 1 and with 0.
- Biweekly, anchored to the first week start on or after 2024-01-01, so two devices always agree.
- Monthly with `month_start_day` 1, and with 25 (the period 25 Sep to 24 Oct).
- Yearly with `year_start_month` 4 (1 Apr to 31 Mar).
- Daily.
- Custom: `{ start, end }` from the user, with `shiftPeriod` moving by the same length.
- Leap years, and month lengths (a February period with `month_start_day` 28).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/domain/period.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Work only with calendar dates (year, month, day integers). Do not use `Date` for time zone math. `today()` reads the device local date once and returns a `YYYY-MM-DD` string.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/domain/period.test.ts`
Expected: PASS

### Task 23: IDs and recurrence

**Files:**
- Create: `app/src/domain/ids.ts`, `app/src/domain/ids.test.ts`, `app/src/domain/recurrence.ts`, `app/src/domain/recurrence.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`newId()` returns a UUID v4. `occurrenceId(ruleId, "2026-10-01")` returns a UUID v5 in a fixed project namespace, and the same inputs always give the same output (compare with a hard-coded expected value). `occurrenceDates(rule, upTo)` returns all dates from `start_date` to the lower of `upTo` and `end_date`:

- Daily, weekly and biweekly.
- Monthly from the 31st: 31 Jan, 28 Feb (29 in a leap year), 31 Mar, 30 Apr.
- Yearly from 29 Feb: 28 Feb in non-leap years.
- An `end_date` before `start_date` gives an empty list.
- More than 1000 dates is capped at 1000, and the function reports `truncated: true`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/domain/ids.test.ts src/domain/recurrence.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Use the `uuid` package (`v4`, `v5`). Monthly and yearly occurrences are anchored on the start day and are not chained, so a short month does not move later dates.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/domain/ids.test.ts src/domain/recurrence.test.ts`
Expected: PASS

### Task 24: PowerSync client schema

**Files:**
- Create: `app/src/data/schema.ts`, `app/src/data/schema.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing test**

`schema.test.ts` loads every `schema/*.schema.json` (except `upload`) and checks that the PowerSync table of the same name has exactly the same columns, except `id`, which PowerSync adds. Column types: integer for `*_minor`, `sort_order`, the day and month numbers and the booleans (0 or 1). Text for everything else. The test also checks the two local-only tables: `device_prefs` (`key`, `value`) and `sync_problems` (`table_name`, `record_id`, `op`, `data_json`, `code`, `message`, `created_at`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/data/schema.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Define `AppSchema` with `new Schema({...})` and `new Table({...})` from `@powersync/common` types. Mark the two local-only tables with `{ localOnly: true }`. Add indexes for `transactions` on `date`, `category_id` and `account_id`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/data/schema.test.ts`
Expected: PASS

### Task 25: Spike, then database factories for iOS and the web

**Files:**
- Create: `app/src/data/db.native.ts`, `app/src/data/db.web.ts`, `app/src/data/db.ts` (shared type), `app/src/data/encryptionKey.native.ts`
- Modify: `app/package.json`, `app/app.json`, `app/metro.config.js`
- Type: frontend

- [ ] **Step 1: Install and configure**

Native: install `@powersync/react-native`, `@powersync/op-sqlite`, `@op-engineering/op-sqlite` and `@powersync/react`. Enable SQLCipher for op-sqlite as its docs describe (the `op-sqlite` section in `app/package.json`). `db.native.ts` creates `PowerSyncDatabase` with `OPSqliteOpenFactory({ dbFilename: "money.db", sqliteOptions: { encryptionKey } })`. `encryptionKey.native.ts` reads a 32-byte random key from `expo-secure-store` (`keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), or creates it with `expo-crypto` on first start.

Web: install `@powersync/web` and `@journeyapps/wa-sqlite`. Follow the PowerSync "React Native Web" guide: copy the web worker and wasm assets into `app/public/@powersync/` with the `powersync-web copy-assets` command (add it as a `postinstall` script in `app/package.json`), and open the database with the settings that guide gives for Metro. `db.web.ts` creates `PowerSyncDatabase` with `dbFilename: "money.db"`.

- [ ] **Step 2: Spike check on iOS**

Run: `npx --workspace app expo run:ios` with a temporary debug button on the placeholder screen that writes one row to `accounts` and reads it back.
Expected: the row reads back. The database file on the simulator is not readable as plain SQLite (`sqlite3 <file> .tables` fails with "file is not a database").

- [ ] **Step 3: Spike check on the web**

Run: `npx --workspace app expo start --web` and use the same debug button in Chromium, WebKit and Firefox.
Expected: the row reads back in all three, and it is still there after a reload. If any browser fails, stop and report the error before Phase 4. Remove the debug button after both checks pass.

### Task 26: Auth client, token storage and AuthProvider

**Files:**
- Create: `app/src/auth/api.ts`, `app/src/auth/api.test.ts`, `app/src/auth/tokenStore.native.ts`, `app/src/auth/tokenStore.web.ts`, `app/src/auth/AuthProvider.tsx`, `app/src/auth/AuthProvider.test.tsx`, `app/src/config.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`api.test.ts` mocks `fetch`. On native, every auth call sends `X-Client: native` and `X-Device-Name` (device model from `expo-device`). On the web, refresh sends `credentials: "include"` and `X-Requested-With: money-tracker`. Errors map to typed results (`invalid_credentials`, `invalid_code`, `locked`, `setup_incomplete`, `refresh_invalid`, `network`).

`AuthProvider.test.tsx` covers the states `loading`, `signedOut`, `signedIn` and `reauthRequired`:
- On start, it tries a refresh. On success the state is `signedIn`. On `refresh_invalid` with a known last user ID, the state is `reauthRequired`. With no known user, it is `signedOut`.
- `getAccessToken()` returns the cached token and refreshes it 60 seconds before `exp`. Two calls at the same time share one refresh.
- When a different user signs in, `onUserChange` fires before the new state is published, so the data layer can clear the old data (Task 40).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/auth`
Expected: FAIL

- [ ] **Step 3: Implement**

`config.ts` reads `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_POWERSYNC_URL`. On the web, the API URL defaults to the same origin. `tokenStore.native.ts` keeps the refresh token and the last user ID in `expo-secure-store`. `tokenStore.web.ts` keeps only the last user ID in `localStorage`. The access token stays in memory on both platforms.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/auth`
Expected: PASS

### Task 27: PowerSync connector

**Files:**
- Create: `app/src/data/connector.ts`, `app/src/data/connector.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

Mock the database and `fetch`.
- `fetchCredentials` returns `{ endpoint: POWERSYNC_URL, token }` from `getAccessToken()`, or null when signed out.
- `uploadData` takes the next CRUD transaction and posts `{ schema_version: SCHEMA_VERSION, ops }`, where each op has `op`, `table`, `id` and `data` (from `opData`). On 200 with an empty `rejected`, it completes the transaction.
- On 200 with rejections, it writes one `sync_problems` row per rejected op (table, record ID, op, data JSON, code, message, time) and then completes the transaction, so the queue moves on.
- On 401, it refreshes once and retries. If the refresh fails, it sets `reauthRequired` and throws, so the queue stays.
- On 426, it sets the app flag `updateRequired` and throws.
- On a network error or 5xx, it throws, so PowerSync retries later.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/data/connector.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Implement the `PowerSyncBackendConnector` interface with the behaviour above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/data/connector.test.ts`
Expected: PASS

### Task 28: Report and list queries

**Files:**
- Create: `app/src/data/queries.ts`, `app/src/data/queries.test.ts`, `app/test/sqlite.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`app/test/sqlite.ts` creates an in-memory better-sqlite3 database with plain tables that have the same names and columns as `AppSchema`, plus a fixture loader. Every query in `queries.ts` is a SQL string plus a parameter builder, so the tests run the exact SQL the app runs. Cases:

- `periodTotals(range, accountId | null)` returns income, expense and balance. Transfers never count for "all accounts". For one account, a transfer in and a transfer out appear as separate `transfer_in` and `transfer_out` values, not as income or expense.
- `categoryTotals(range, accountId | null, type)` is sorted by amount, descending, and archived categories still show their name.
- `carryOver(range.start, accountIds)` returns one balance per non-archived account from all rows with `date < start`. The formula is income minus expense plus transfers in minus transfers out. Accounts with zero still appear.
- With `hide_future` on, rows after `today` are left out of totals and lists.
- `transactionList(range, filters, sort, search)` filters by account, category and type. Search matches `name` and `note` case-insensitively. Sorting is by date (default, newest first), name or amount. The list includes the virtual Carry Over rows when `carry_over` is on, marked `kind: "carryOver"`, dated `range.start`.
- `budgetProgress(range)` returns the overall budget for the setting's period and the spent amount, or null when `budget_mode` is off or no budget exists.
- `cashFlowSeries(endRange, kind, count)` returns income and expense per period for the last `count` periods.
- Performance: with 50,000 transactions, `periodTotals` and a 100-row `transactionList` page each finish in under 50 ms in the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/data/queries.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the SQL with parameters only. Expose React hooks that wrap each query with `useQuery` from `@powersync/react`, so the screens update on every local change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/data/queries.test.ts`
Expected: PASS

### Task 29: Mutations, delayed delete with Undo, and the recurring generator

**Files:**
- Create: `app/src/data/mutations.ts`, `app/src/data/mutations.test.ts`, `app/src/data/UndoProvider.tsx`, `app/src/data/UndoProvider.test.tsx`, `app/src/data/recurringGenerator.ts`, `app/src/data/recurringGenerator.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`mutations.test.ts` runs against the test SQLite helper:
- `saveTransaction(input)` validates with the same rules as the API (amount, category type, transfer rules) and returns typed errors. On success, it inserts with `newId()`, `user_id`, `currency_code` from settings and `source: "manual"`. On edit, it updates only the changed columns, so PowerSync sends a PATCH with only those fields.
- `saveCategory`, `archiveCategory`, `saveAccount` and `archiveAccount` behave the same way. `deleteCategory` and `deleteAccount` are refused locally when transactions use them.
- `updateSettings(patch)` updates the one settings row.

`UndoProvider.test.tsx` uses fake timers:
- `requestDelete(id)` hides the row from lists at once.
- After 5 seconds, it runs the real `DELETE`.
- `undo()` within 5 seconds restores the row, and no delete runs.
- When the app goes to the background, all pending deletes run at once.

`recurringGenerator.test.ts`:
- `generateDue(today)` inserts one transaction per due occurrence with `occurrenceId(rule.id, date)`, `source: "recurring"` and `recurring_rule_id`.
- A second run inserts nothing.
- An existing row with that ID (also an edited one) is never overwritten.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/data/mutations.test.ts src/data/UndoProvider.test.tsx src/data/recurringGenerator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

The generator runs after the first full sync on start, when the local date changes, and after a rule is saved. It uses `INSERT OR IGNORE` semantics. The local validation lives in `app/src/domain/validation.ts`, and mutations and forms both use it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/data/mutations.test.ts src/data/UndoProvider.test.tsx src/data/recurringGenerator.test.ts`
Expected: PASS

### Task 30: Sync state

**Files:**
- Create: `app/src/sync/syncState.ts`, `app/src/sync/syncState.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`deriveSyncState({ status, pendingCount, problemCount, auth, updateRequired })` returns one of `synced`, `syncing`, `offline`, `needsAttention`, `reauthRequired` or `updateRequired`, plus a label such as "Synced 1 min ago · 0 pending" or "Offline · 2 pending". Priority order: `updateRequired`, `reauthRequired`, `needsAttention` (problems > 0), `offline` (not connected), `syncing` (uploading or downloading), `synced`. `lastSyncedAt` comes from the PowerSync status.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/sync/syncState.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the pure function and a `useSyncState()` hook that combines `useStatus()` from `@powersync/react`, the upload queue count, the `sync_problems` count and the auth state.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/sync/syncState.test.ts`
Expected: PASS

---

## Phase 4: UI

Every screen copies the approved mockups. On the phone, the tab bar is at the bottom by default, and the device setting "Tabs Position" moves it to the top. Every screen gets a render test with `@testing-library/react-native` that checks the listed texts and the accessibility labels.

### Task 31: Theme, textures and icons

**Files:**
- Create: `app/src/ui/theme.ts`, `app/src/ui/icons/tabIcons.tsx`, `app/src/ui/icons/categoryIcons.tsx`, `app/src/ui/icons/categoryIcons.test.tsx`, `app/src/ui/Texture.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

`categoryIcons.test.tsx` checks that the registry has exactly these keys: `fork`, `cart`, `groceries`, `music`, `bus`, `flame`, `tax`, `gift`, `key`, `calculator`, `book`, `tag`, `piggy`, `coins`, `car`, `home`, `health`, `phone`, `coffee`, `plane`, `baby`, `shirt`, `sport` and `pet`. Each key renders in `filled` and `outline` style and has an English label for accessibility. The default categories from Task 12 use only keys from this list. Copy the list into a Go test in `api/internal/users/seed_test.go` too.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/ui/icons`
Expected: FAIL

- [ ] **Step 3: Implement**

`theme.ts` holds the colours from the mockups: status bar brown `#5b3522`, ink `#4b3022`, accent `#8a5a44`, paper `#f1ece2`, row `#f6f2ea`, line `#e2d9c8`, carry-over peach `#f6dfc6`, chalk background `#2a2a2a`, chalk green `#8ee08f`, chalk red `#ff8a86`, chalk blue `#83defa`, list green `#3b9d3b`, list red `#c62f2f`, transfer button `#36c94a`, settings blue `#1d4f9a`, and dark theme versions of each. Fonts: Droid Sans Mono for the chalkboard when `summary_font` is `mono`, the system font otherwise. Draw the tab icons (tag, notepad, filing cabinet, people, pie, gear) as `react-native-svg` components with outline and filled versions, from the SVG paths in the mockup. `Texture.tsx` tiles `paper.png` or `chalk.png` behind its children.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/ui/icons`
Expected: PASS

### Task 32: Shared components

**Files:**
- Create: `app/src/ui/components/PaperBar.tsx`, `PeriodPill.tsx`, `PeriodPicker.tsx`, `SegmentedControl.tsx`, `ListRow.tsx`, `TransactionRow.tsx`, `GroupedSection.tsx`, `FormRow.tsx`, `Banner.tsx`, `UndoToast.tsx`, `AmountKeypad.tsx`, `components.test.tsx` (all under `app/src/ui/components/`)
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`components.test.tsx` checks:
- `PeriodPill` shows the period label and opens `PeriodPicker` (Week, Month, Year, Custom with two date fields).
- `SegmentedControl` reports its selection and has `accessibilityRole="tab"` items.
- `TransactionRow` shows name, "account, weekday, date", the amount in red or green with a sign in the accessibility label ("expense 14 euro 99"), the repeat mark for recurring rows and the peach style for Carry Over.
- `Banner` renders the title, the text and an action button.
- `UndoToast` shows "Deleted · Undo" and calls `undo`.
- `AmountKeypad` builds an expression and shows the evaluated amount.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/ui/components`
Expected: FAIL

- [ ] **Step 3: Implement**

Build each component to match the mockups. Text uses `allowFontScaling`, and rows grow with Dynamic Type.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/ui/components`
Expected: PASS

### Task 33: Navigation shell, sidebar and shortcuts

**Files:**
- Create: `app/app/(main)/_layout.tsx`, `app/src/ui/nav/TabBar.tsx`, `app/src/ui/nav/Sidebar.tsx`, `app/src/hooks/useLayoutMode.ts`, `app/src/hooks/useLayoutMode.test.ts`, `app/src/hooks/useShortcuts.web.ts`, `app/src/hooks/useShortcuts.ts`, `app/src/hooks/useDevicePrefs.ts`
- Type: frontend

- [ ] **Step 1: Write the failing test**

`useLayoutMode.test.ts`: a web width of 900 or more gives `sidebar`. Below 900, or on native, it gives `tabs`. A native phone in landscape gives `phoneLandscape`. An iPad in landscape gives `tabletSplit`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/hooks/useLayoutMode.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`(main)/_layout.tsx` uses Expo Router `Tabs` with a custom `tabBar`:
- In `tabs` mode it renders `TabBar` with Spending, Transactions, Categories and Accounts, at the bottom or the top from the device pref `tabsPosition`. The ⋮ menu opens Settings.
- In `sidebar` mode it renders `Sidebar` on the left: brand, pages 1 to 5 (with Reports), the quick-add buttons Expense, Income and Transfer, then Settings, the sync state and the user with "Log out" at the bottom. The content goes in a centred 640 px card on the paper desk texture, below a header row with title, ‹ ›, period pill and W/M/Y/Custom.

`useShortcuts.web.ts` binds `1` to `5` (pages), `E`, `I` and `T` (new expense, income, transfer), `/` (focus search) and `Enter` in forms (save). It ignores keys while an input has focus, except `Enter` and `Escape`. `useShortcuts.ts` (native) does nothing. `useDevicePrefs` reads and writes the local-only `device_prefs` table.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/hooks/useLayoutMode.test.ts`
Expected: PASS

### Task 34: Auth screens

**Files:**
- Create: `app/app/(auth)/login.tsx`, `app/app/(auth)/login-totp.tsx`, `app/app/(auth)/invite.tsx`, `app/app/(auth)/auth.test.tsx`
- Modify: `app/app/_layout.tsx` (auth gate)
- Type: frontend

- [ ] **Step 1: Write the failing tests**

- Login shows email and password fields, a disabled button until both are filled, and the error "Wrong email or password" for `invalid_credentials`, or "Too many attempts. Try again in 15 minutes." for `locked`.
- The TOTP screen accepts 6 digits, auto-submits, and has the link "Use a recovery code".
- Invite (`/invite?token=`): step 1 is the password (at least 12 characters, typed twice). Step 2 shows the QR code from `otpauth_url`, the secret as text with a copy button, and a 6-digit field. Step 3 shows the 10 recovery codes with "Copy all" and the checkbox "I saved these codes", which enables "Continue".
- The root gate sends `signedOut` users to login, and shows the `reauthRequired` login as a modal over the app.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- app/(auth)`
Expected: FAIL

- [ ] **Step 3: Implement**

Use the paper and brown style. After a successful login, call `db.connect(connector)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- app/(auth)`
Expected: PASS

### Task 35: Spending screen

**Files:**
- Create: `app/app/(main)/spending.tsx`, `app/src/ui/screens/Chalkboard.tsx`, `app/src/ui/screens/Chalkboard.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

With fixture data, `Chalkboard` shows:
- The account picker "‹ All Accounts ›", which cycles through All and each account.
- The income and expense bar. The red part is the expense share of income, or of the budget in budget mode.
- Income with a Carry Over sub-line when it is on, then income categories. For one account, also Transfer in.
- Expense with category sub-lines sorted by amount. For one account, also Transfer out.
- A dashed line, then Balance with a sign.
- The buttons "+ Expense" and "+ Income".
- On a phone, "** Rotate device to view reports **".

Tapping a category line opens Transactions filtered by that category. The accessibility summary reads "Income 95,603 euro 20, expense 3,168 euro 49, balance plus 92,434 euro 71".

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/ui/screens/Chalkboard.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Use the hooks from Task 28 and the chalk texture. The chalk text has a light text shadow.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/ui/screens/Chalkboard.test.tsx`
Expected: PASS

### Task 36: Transactions screen

**Files:**
- Create: `app/app/(main)/transactions.tsx`, `app/src/ui/screens/TransactionList.tsx`, `app/src/ui/screens/TransactionList.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

The screen shows:
- The paper bar with the account name. On the web, also the search field and Sort, Filter and Export. Export is shown disabled with the tooltip "Coming soon", because export is a later sub-project.
- The green and red totals bar.
- The list with Carry Over rows.
- On the phone, the bottom toolbar with ‹ ›, filter and account picker.

Rows hidden by the Undo flow do not render. A tap opens the form. Swipe left (native) or the Delete key (web) starts `requestDelete`. Search filters while typing (debounced 200 ms). The list virtualises with `FlatList` and renders 50,000 fixture rows without errors.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/ui/screens/TransactionList.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the screen with the hooks from Task 28 and `UndoProvider`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/ui/screens/TransactionList.test.tsx`
Expected: PASS

### Task 37: Transaction form

**Files:**
- Create: `app/app/transaction/[id].tsx`, `app/src/ui/screens/TransactionForm.tsx`, `app/src/ui/screens/TransactionForm.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

- The route `new?type=expense|income|transfer` opens an empty form, and an ID opens an edit.
- The Expense / Income / Transfer switch changes the fields. Transfer shows From and To accounts and no category.
- The amount field opens the keypad.
- Fields: Name, Date (defaults to today), Category (grid of the type's categories, archived ones hidden), Account (defaults to the last used one, stored in `device_prefs`), the Repeating toggle with Every and End Date, and Note.
- Save is disabled until the form is valid, and validation errors show under each field.
- Saving a repeating transaction creates or updates the rule and runs the generator.
- Delete (edit only) uses `requestDelete` and goes back.
- The header has Cancel and Save on iOS, ✕ and SAVE on the web.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/ui/screens/TransactionForm.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the form with the mutations from Task 29.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/ui/screens/TransactionForm.test.tsx`
Expected: PASS

### Task 38: Categories and Accounts

**Files:**
- Create: `app/app/(main)/categories.tsx`, `app/app/category/[id].tsx`, `app/app/(main)/accounts.tsx`, `app/app/account/[id].tsx`, `app/src/ui/screens/CategoriesAccounts.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

- Categories shows the Expense / Income switch and the list with glyph icons in `sort_order`. The "+" button opens the category form (name, icon grid, colour palette of 12 colours, type). Long-press, or a drag handle on the web, reorders and saves `sort_order`. The form has Archive. Delete shows only when no transaction uses the category.
- Accounts shows the green Transfer button (it opens the form with type transfer), the list with coloured person icons, and the footer hint text from the mockup. The account form has name and colour, plus Archive or Delete under the same rule.
- Archived items appear in a collapsed "Archived" section with Restore.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/ui/screens/CategoriesAccounts.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the screens and forms with the mutations from Task 29.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/ui/screens/CategoriesAccounts.test.tsx`
Expected: PASS

### Task 39: Reports

**Files:**
- Create: `app/app/(main)/reports.tsx`, `app/src/ui/charts/PieChart.tsx`, `app/src/ui/charts/CashFlowChart.tsx`, `app/src/ui/screens/Reports.tsx`, `app/src/ui/screens/Reports.test.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

- `Reports` shows the Categories / Cash Flow switch. The pie (react-native-svg with a radial gradient for the shaded look) has a legend, percentage labels above 5 %, and a text summary of the top five categories plus others.
- Cash Flow shows income and expense lines for the last 8 periods. Tapping a point shows both values in two pills.
- ◀ ▶ moves the period.
- Tapping a slice opens Transactions filtered by that category.
- Phone landscape renders `Reports` full screen with a dark background instead of Spending or Transactions. The web shows it as page 5.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/ui/screens/Reports.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the charts with react-native-svg only. No chart library.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/ui/screens/Reports.test.tsx`
Expected: PASS

### Task 40: Settings, sessions, sync problems and logout

**Files:**
- Create: `app/app/settings.tsx`, `app/app/sessions.tsx`, `app/app/sync-problems.tsx`, `app/src/ui/screens/Settings.test.tsx`, `app/src/data/session.ts`, `app/src/data/session.test.ts`
- Type: frontend

- [ ] **Step 1: Write the failing tests**

`Settings.test.tsx` checks the grouped sections from the mockup:
- **Spending:** Time Period, Budget Mode (when on, also Budget Amount), Carry Over, Hide Future Transactions.
- **Sync:** Home Server Sync with the sync state label, "Sync problems (n)" when n > 0, and Devices (sessions).
- **User Interface:** Dark Theme, Show Transaction Note, Currency Symbol (read only, set at invite), Summary Font, Category Icon Style. On native, also Tabs Position.
- **Security** (native only): App Lock and Lock After.
- **General:** Reset local data, and Log out.

Synced settings write through `updateSettings`. Device settings write to `device_prefs`.

`session.test.ts`:
- `logout()` calls the API logout, clears tokens and calls `db.disconnectAndClear()`. If the upload queue is not empty, it first asks for confirmation ("2 changes are not synced yet and will be lost").
- `onUserChange` runs `disconnectAndClear()` before it connects as the new user.
- `resetLocalData()` asks for confirmation when changes are pending, then clears and reconnects.

The sync problems screen lists each problem with its message and offers "Edit and retry" (opens the form with the saved data, and saving removes the problem) and "Discard". The sessions screen lists devices, marks the current one, and revokes others.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace app test -- src/ui/screens/Settings.test.tsx src/data/session.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Write the screens and `session.ts`. Mount the banners in the root layout: Needs attention (opens sync problems), Log in again (opens the modal login), Update the app (`updateRequired`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace app test -- src/ui/screens/Settings.test.tsx src/data/session.test.ts`
Expected: PASS

### Task 41: App lock and privacy cover

**Files:**
- Create: `app/src/security/AppLock.tsx`, `app/src/security/AppLock.test.tsx`
- Modify: `app/app/_layout.tsx`
- Type: frontend

- [ ] **Step 1: Write the failing test**

Mock `expo-local-authentication` and `AppState`.
- With App Lock off, nothing happens.
- With it on, the app starts locked and calls `authenticateAsync({ promptMessage: "Unlock Money Tracker", disableDeviceFallback: false })`. Success unlocks. Failure shows a paper screen with an "Unlock" button.
- On `background` the privacy cover shows at once. On return, the app locks again only if the time away is at least the Lock After setting (0, 60 or 300 seconds).
- When the device has no biometrics and no passcode, the setting cannot be turned on, and the screen shows "Set up a passcode on this device first".

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace app test -- src/security`
Expected: FAIL

- [ ] **Step 3: Implement**

`AppLock` wraps the signed-in app on native only. On the web it renders its children.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace app test -- src/security`
Expected: PASS

---

## Phase 5: End-to-end tests

### Task 42: Shared e2e support

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/support/stack.ts`, `e2e/support/users.ts`, `e2e/support/totp.ts`, `e2e/support/toxiproxy.ts`, `e2e/support/db.ts`
- Type: both

- [ ] **Step 1: Write the helpers**

- `stack.ts` checks that the Compose stack is healthy and resets data between test files: it truncates the user tables through `docker compose exec postgres psql` and restarts nothing.
- `users.ts` creates a ready user through the real API: `mtapi admin invite`, then `invite/accept` and `invite/confirm` with a code from `totp.ts`. It returns email, password, TOTP secret and recovery codes.
- `totp.ts` uses the `otpauth` package and waits for a fresh 30-second step when the current one has less than 5 seconds left.
- `toxiproxy.ts` turns the `api` and `powersync` proxies off and on, and adds latency, through the Toxiproxy HTTP API on port 8474.
- `db.ts` runs read-only SQL checks against PostgreSQL (row counts per user).

- [ ] **Step 2: Verify**

Run: `make stack-up && npm --workspace e2e run typecheck`
Expected: exits 0.

### Task 43: Web e2e suite (Playwright)

**Files:**
- Create: `e2e/web/playwright.config.ts`, `e2e/web/login.spec.ts`, `e2e/web/transactions.spec.ts`, `e2e/web/offline.spec.ts`, `e2e/web/conflicts.spec.ts`, `e2e/web/isolation.spec.ts`, `e2e/web/rejection.spec.ts`, `e2e/web/layout.spec.ts`
- Type: both

- [ ] **Step 1: Write the specs**

Run against `http://localhost:8088` in the projects chromium, webkit and firefox.

- `login.spec.ts`: an invite flow through the UI. Login with password and TOTP. A wrong code shows the error. A recovery code works once. Reload keeps the session (cookie refresh). Logout clears the local data.
- `transactions.spec.ts`: add an expense, income and transfer with the keyboard shortcuts. Check the chalkboard totals, the transfer that does not change totals for All Accounts, the Carry Over rows in the next month, and delete with Undo, then delete without Undo (the row is gone in PostgreSQL after 5 seconds).
- `offline.spec.ts`: turn off both proxies, add three expenses, check "Offline · 3 pending" in the sidebar, turn the proxies on, and wait for "Synced". PostgreSQL has exactly three rows. Then turn off only the API proxy during an upload and check that a retry gives no duplicate.
- `conflicts.spec.ts`: two browser contexts for the same user. The cases are: edits to different fields (both survive on both sides), edits to the same field (the last upload wins on both sides), and delete against an offline edit (the row stays deleted on both sides, with no problem banner).
- `isolation.spec.ts`: users A and B. B never sees A's rows. A forged upload with A's record ID through `page.request` returns the rejection `forbidden`.
- `rejection.spec.ts`: make a permanent rejection (archive a category in context 1, delete it on the server with SQL, then save a transaction with that category offline in context 2). The "1 change could not sync" banner shows, later changes still sync, and "Discard" clears the banner.
- `layout.spec.ts`: at 1280 px the sidebar shows, and keys 1 to 5 switch pages. At 800 px the tabs show.

- [ ] **Step 2: Run the suite**

Run: `make stack-up && make e2e-web`
Expected: all specs pass in all three browsers.

### Task 44: iOS e2e suite (Maestro)

**Files:**
- Create: `app/e2e/maestro/login.yaml`, `app/e2e/maestro/add-edit-delete.yaml`, `app/e2e/maestro/offline-add.yaml`, `app/e2e/maestro/rejection.yaml`, `app/e2e/maestro/app-lock.yaml`, `app/e2e/maestro/ipad-landscape.yaml`, `e2e/ios/run.ts`
- Modify: `e2e/package.json` (script `test:ios`)
- Type: both

- [ ] **Step 1: Write the flows and the runner**

Add `testID` values in the app wherever the flows tap. The flows read `EMAIL`, `PASSWORD` and `TOTP_CODE` from Maestro env variables.

`run.ts`:
1. Builds a Release simulator app once with `npx expo run:ios --configuration Release --no-bundler`, with `EXPO_PUBLIC_API_URL=http://localhost:18080` and `EXPO_PUBLIC_POWERSYNC_URL=http://localhost:18081`.
2. Creates users with `e2e/support/users.ts`.
3. Runs each flow with `maestro test`. For the login steps, it computes a fresh TOTP code right before it starts the flow.
4. For `offline-add.yaml`, it turns the Toxiproxy proxies off before the flow and on after it, then checks PostgreSQL row counts with `e2e/support/db.ts`.
5. For `app-lock.yaml`, it enrolls Face ID with `xcrun simctl spawn booted notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` and `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit.enrollmentChanged`. It sends a match with `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match` and a failure with `com.apple.BiometricKit_Sim.pearl.nomatch` at the points where the flow waits. Check these notification names on the installed Xcode before you rely on them. If they changed, use the Simulator menu item through `osascript` instead.
6. Runs `ipad-landscape.yaml` on an iPad simulator and checks that the chalkboard and the list show side by side.

- [ ] **Step 2: Run the suite on the Mac**

Run: `make stack-up && npm --workspace e2e run test:ios`
Expected: all flows pass.

### Task 45: Cross-app e2e

**Files:**
- Create: `e2e/cross/run.ts`, `e2e/cross/scenarios.ts`, `app/e2e/maestro/cross-add-expense.yaml`, `app/e2e/maestro/cross-edit-note.yaml`, `app/e2e/maestro/cross-check-row.yaml`
- Modify: `e2e/package.json` (script `test:cross`)
- Type: both

- [ ] **Step 1: Write the scenarios**

One user is logged in on the iOS simulator (Maestro) and in Playwright Chromium.

1. Add an expense on iOS. The web shows it within 10 seconds.
2. Turn off the proxies for iOS only. Do this by giving the iOS app its own Toxiproxy pair (`api_ios` on 18090 and `powersync_ios` on 18091, added to `toxiproxy.json`), and point the iOS build at them. Edit the amount on the web and the note on iOS. Turn the proxies on. Both devices show the new amount and the new note.
3. Delete on the web while iOS is offline and edits the same row. After the reconnect, the row is gone on both.

- [ ] **Step 2: Run the suite on the Mac**

Run: `make stack-up && npm --workspace e2e run test:cross`
Expected: all three scenarios pass.

---

## Phase 6: CI and release

### Task 46: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/dependabot.yml`
- Type: both

- [ ] **Step 1: Write the workflow**

Trigger on push and pull request. Jobs on `ubuntu-latest`:
- `generated`: `make check-generated`.
- `api`: `go -C api vet ./...`, `go -C api test -race ./...` (testcontainers works with the runner's Docker), `govulncheck`, `gosec`.
- `app`: `npm ci`, lint, `npm --workspace app test`, `npx --workspace app tsc --noEmit`, `npm audit --audit-level=high`.
- `e2e-web`: `make stack-up`, `npx playwright install --with-deps`, `make e2e-web`. Upload the Playwright report on failure.
- `images`: build the three images for `linux/amd64` and run Trivy (`aquasecurity/trivy-action`, fail on HIGH and CRITICAL with a fix available).

Pin every third-party action to a full commit SHA. `dependabot.yml` updates npm, gomod, docker and github-actions weekly.

- [ ] **Step 2: Verify**

Run: `npx --yes @action-validator/cli .github/workflows/ci.yml`
Expected: no errors. Push the branch, and all jobs pass on GitHub.

### Task 47: iOS e2e workflow on the self-hosted Mac runner

**Files:**
- Create: `.github/workflows/ios-e2e.yml`
- Modify: `docs/operations.md` (runner setup)
- Type: both

- [ ] **Step 1: Write the workflow**

Trigger: `schedule` (nightly at 03:00) and `workflow_dispatch`. `runs-on: [self-hosted, macOS, money-tracker]`. Steps: checkout, `npm ci`, `make stack-up`, `npm --workspace e2e run test:ios`, `npm --workspace e2e run test:cross`, `make stack-down` (always). Upload Maestro artifacts on failure. In `docs/operations.md`, document how to register your Mac as a runner with the labels `self-hosted`, `macOS`, `money-tracker`, and the requirements: Xcode, an iOS simulator runtime, Docker Desktop, Maestro, and Node LTS.

- [ ] **Step 2: Verify**

Run: `npx --yes @action-validator/cli .github/workflows/ios-e2e.yml`
Expected: no errors. A manual dispatch on GitHub passes on your Mac.

### Task 48: Release images and the iOS build

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `docs/operations.md`
- Type: both

- [ ] **Step 1: Write the workflow**

Trigger on tags `v*`. Use `docker/setup-qemu-action` and `docker/setup-buildx-action`, log in to Docker Hub with the secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`, and build and push `kyosifov/money-tracker-api`, `kyosifov/money-tracker-powersync` and `kyosifov/money-tracker-web` for `linux/amd64,linux/arm64` with the git tag as the image tag. In `docs/operations.md`, document the release order:
1. Tag.
2. Wait for the images.
3. Bump the three tags in `home-infrastructure/k8s/money-tracker/*.yaml`.
4. Run `./deploy.sh money-tracker upgrade`.
5. Build the iOS app with `eas build --platform ios --profile production` and install it through TestFlight. This needs an Apple Developer account.

Add `app/eas.json` with `development`, `preview` and `production` profiles. The production profile sets `EXPO_PUBLIC_API_URL=https://money.kyosifov.com` and `EXPO_PUBLIC_POWERSYNC_URL=https://money-sync.kyosifov.com`.

- [ ] **Step 2: Verify**

Run: `npx --yes @action-validator/cli .github/workflows/release.yml && npx --workspace app eas config --platform ios --profile production`
Expected: no errors, and the resolved config shows both URLs.

---

## Phase 7: Infrastructure (home-infrastructure)

Run every command in this phase from the root of `home-infrastructure`. Prerequisites: the CNPG operator runs in `homedb-operator`, and the Phase 6 images exist on Docker Hub.

### Task 49: App folder, namespace and secrets

**Files:**
- Create: `home-infrastructure/k8s/money-tracker/app.conf`, `home-infrastructure/k8s/money-tracker/namespace.yaml`, `home-infrastructure/k8s/money-tracker/secrets/money-tracker-secrets.yaml`
- Type: backend

- [ ] **Step 1: Write the files**

`app.conf`, following `k8s/bookero/app.conf`:
- `NEEDS_HELM=false`
- `NAMESPACE=money-tracker`
- `SECRETS_DIR=secrets`
- `MANIFESTS="postgres.yaml api.yaml powersync.yaml web.yaml network-policy.yaml backup-jobs.yaml ingress.yaml gateway-referencegrant.yaml snippetsfilter.yaml httproute.yaml"`
- `DEPENDS_ON="ingress-nginx cert-manager"`
- `CONFIRM_UNINSTALL=true`

`namespace.yaml` creates the namespace `money-tracker` with label `scraper: prometheus`, and a `LimitRange` copied from bookero.

The secret file starts as `money-tracker-secrets.secret.plaintext.yaml` (ignored by git) and holds three Secrets:

1. `money-tracker-api`:
   - `JWT_PRIVATE_KEY_PEM` from `openssl genpkey -algorithm ed25519`.
   - `TOTP_ENC_KEY` from `openssl rand -base64 32`.
2. `money-tracker-db-roles`, of type `kubernetes.io/basic-auth`, with random passwords for `powersync_repl`, `powersync_storage` and `money_restore_check`. CNPG reads one `username` and `password` pair per secret, so create three secrets: `money-tracker-pg-powersync-repl`, `money-tracker-pg-powersync-storage` and `money-tracker-pg-restore-check`.
3. `money-tracker-powersync-config`, with key `powersync.yaml`: the Task 19 config with the in-cluster hosts `money-tracker-db-rw` and `jwks_uri: http://money-tracker-api:8080/api/.well-known/jwks.json`.

Encrypt the plaintext file with `scripts/sops-encrypt.sh` into `secrets/money-tracker-secrets.yaml`, then delete the plaintext.

Store a copy of the JWT key and `TOTP_ENC_KEY` in your password manager. Without `TOTP_ENC_KEY`, no user can log in after a restore.

- [ ] **Step 2: Verify**

Run: `scripts/sops-decrypt.sh k8s/money-tracker/secrets/money-tracker-secrets.yaml | grep -c "kind: Secret"`
Expected: `5` (`money-tracker-api`, three role secrets, `money-tracker-powersync-config`).

### Task 50: CloudNativePG cluster

**Files:**
- Create: `home-infrastructure/k8s/money-tracker/postgres.yaml`
- Type: backend

- [ ] **Step 1: Check the operator features**

Run: `kubectl get crd clusters.postgresql.cnpg.io databases.postgresql.cnpg.io && kubectl -n homedb-operator get deploy -o jsonpath='{.items[0].spec.template.spec.containers[0].image}'`
Expected: both CRDs exist and the operator image is 1.25 or newer. If `databases.postgresql.cnpg.io` is missing, create the `powersync_storage` database with a `postInitSQL` entry in the Cluster instead of the `Database` resource below.

- [ ] **Step 2: Write the manifest**

The `Cluster` named `money-tracker-db` has:
- `instances: 1`
- `imageName: ghcr.io/cloudnative-pg/postgresql:17`
- `storage.storageClass: longhorn-encrypted`, size `5Gi`
- `bootstrap.initdb` with database `money` and owner `money` (CNPG creates the secret `money-tracker-db-app`)
- `managed.roles`: `powersync_repl` (login, replication), `powersync_storage` (login) and `money_restore_check` (login, createdb, member of `pg_read_all_data`), each with its `passwordSecret` from Task 49
- Resources: requests `cpu: 100m`, `memory: 256Mi`; limits `cpu: 1`, `memory: 768Mi`
- `monitoring.enablePodMonitor: false`, because ServiceMonitors live in the prometheus app

A `Database` resource named `money-tracker-powersync-storage` creates `powersync_storage` with owner `powersync_storage`. CNPG sets `wal_level` to `logical` by default.

- [ ] **Step 3: Verify after the first deploy (Task 55)**

Run: `kubectl -n money-tracker exec money-tracker-db-1 -- psql -U postgres -tAc "SHOW wal_level; SELECT rolreplication FROM pg_roles WHERE rolname='powersync_repl'; SELECT datname FROM pg_database WHERE datname='powersync_storage';"`
Expected: `logical`, `t`, `powersync_storage`.

### Task 51: API, PowerSync and web workloads

**Files:**
- Create: `home-infrastructure/k8s/money-tracker/api.yaml`, `home-infrastructure/k8s/money-tracker/powersync.yaml`, `home-infrastructure/k8s/money-tracker/web.yaml`
- Type: backend

- [ ] **Step 1: Write the manifests**

All pods use the bookero `securityContext` (non-root, `readOnlyRootFilesystem`, drop ALL, `seccompProfile: RuntimeDefault`) and `imagePullPolicy: Always` with a pinned tag.

**`api.yaml`**: a Deployment `money-tracker-api` with 1 replica (the rate limiter is in memory) and `strategy: Recreate`.
- Init container `migrate` runs the same image with args `["migrate"]`.
- Main container args `["serve"]`, port 8080, probes on `/healthz`.
- Env: `DATABASE_URL` from the `uri` key of `money-tracker-db-app`; `JWT_PRIVATE_KEY_PEM` and `TOTP_ENC_KEY` from `money-tracker-api`; `JWT_ISSUER` and `PUBLIC_URL` `https://money.kyosifov.com`; `COOKIE_SECURE=true`; `TRUSTED_PROXY_CIDRS=10.42.0.0/16`.
- Resources: requests `cpu: 50m`, `memory: 64Mi`; limits `cpu: 1`, `memory: 256Mi`. The limit leaves room for Argon2id at 64 MiB per login.
- A Service `money-tracker-api` on port 8080.

**`powersync.yaml`**: a Deployment `money-tracker-powersync` with 1 replica.
- The config secret is mounted at `/config/powersync.yaml`, with the start command the image docs give for a config file path.
- A writable `emptyDir` at `/tmp`.
- Probes on the PowerSync health endpoint from its docs.
- Resources: requests `cpu: 100m`, `memory: 256Mi`; limits `cpu: 1`, `memory: 768Mi`.
- A Service `money-tracker-powersync` on port 8080.

**`web.yaml`**: a Deployment `money-tracker-web` with 2 replicas.
- `nginx-unprivileged` from our image, port 8080, `emptyDir` mounts at `/tmp` and `/var/cache/nginx`.
- Env: `API_UPSTREAM=http://money-tracker-api:8080`, `POWERSYNC_URL=https://money-sync.kyosifov.com`, `POWERSYNC_WS_URL=wss://money-sync.kyosifov.com`.
- Probes on `/`.
- A Service `money-tracker` on port 80 to 8080.

- [ ] **Step 2: Verify**

Run: `kubectl apply --dry-run=server -n money-tracker -f k8s/money-tracker/api.yaml -f k8s/money-tracker/powersync.yaml -f k8s/money-tracker/web.yaml`
Expected: all objects are "created (server dry run)". This needs the namespace from Task 55 Step 1.

### Task 52: Network policies

**Files:**
- Create: `home-infrastructure/k8s/money-tracker/network-policy.yaml`
- Type: backend

- [ ] **Step 1: Write the policies**

Use the shape of `k8s/mail-relay/network-policy.yaml`:
- `default-deny-ingress` for all pods.
- `web` allows port 8080 from the namespaces `ingress-nginx` and `nginx-gateway` (select by `kubernetes.io/metadata.name`).
- `powersync` allows port 8080 from the same two namespaces.
- `api` allows port 8080 from the pods `money-tracker-web` and `money-tracker-powersync` (for JWKS).
- `db` allows port 5432 from `money-tracker-api`, `money-tracker-powersync` and the backup job pods (label `app: money-tracker-backup`), and allows the CNPG operator namespace `homedb-operator` on ports 8000 and 5432.

Egress stays open, as in the other apps.

- [ ] **Step 2: Verify after deploy (Task 55)**

Run: `kubectl -n money-tracker run np-test --rm -i --restart=Never --image=busybox -- wget -qO- -T 3 http://money-tracker-api:8080/healthz`
Expected: a timeout (the test pod is not allowed). The app still works through the browser.

### Task 53: Edge routing for both hosts

**Files:**
- Create: `home-infrastructure/k8s/money-tracker/ingress.yaml`, `home-infrastructure/k8s/money-tracker/httproute.yaml`, `home-infrastructure/k8s/money-tracker/gateway-referencegrant.yaml`, `home-infrastructure/k8s/money-tracker/snippetsfilter.yaml`
- Modify: `home-infrastructure/k8s/nginx-gateway-fabric/gateway.yaml` (after the `bookero` listener)
- Type: backend

- [ ] **Step 1: Write the routing**

**`ingress.yaml`**: two Ingresses with the bookero annotations (`cert-manager.io/cluster-issuer: letsencrypt`, `cert-manager.io/private-key-rotation-policy: Never`, `kubernetes.io/ingress.class: nginx`, `kubernetes.io/tls-acme: "true"`).
- `money.kyosifov.com` goes to Service `money-tracker:80`, TLS secret `money-tracker-tls-cert`.
- `money-sync.kyosifov.com` goes to `money-tracker-powersync:8080`, TLS secret `money-tracker-sync-tls-cert`, with `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"` and `proxy-buffering: "off"` for the long-lived sync stream and websockets.

**`snippetsfilter.yaml`**: `money-tracker-sync-tuning` with `proxy_read_timeout 3600s; proxy_send_timeout 3600s; proxy_buffering off;`.

**`httproute.yaml`**: two routes on `shared-gateway` with the sections `money-tracker` and `money-tracker-sync`. The sync route uses the SnippetsFilter.

**`gateway-referencegrant.yaml`**: grants both TLS secrets to the Gateway.

**`gateway.yaml`**: add two HTTPS listeners on port 8443 (temporary, as for the others), named `money-tracker` and `money-tracker-sync`, with the hostnames and certificate refs above.

Create DNS records for both hostnames the same way as for `bookero.kyosifov.com`.

- [ ] **Step 2: Verify**

Run: `kubectl apply --dry-run=server -f k8s/nginx-gateway-fabric/gateway.yaml && yamllint k8s/money-tracker k8s/nginx-gateway-fabric/gateway.yaml`
Expected: dry run OK, no lint errors.

### Task 54: Backup jobs and the failed-job alert

**Files:**
- Create: `home-infrastructure/k8s/money-tracker/backup-jobs.yaml`
- Modify: `home-infrastructure/k8s/prometheus/alerts.yaml`
- Type: backend

- [ ] **Step 1: Write the jobs**

**PVC:** `money-tracker-dumps`, 5Gi on `longhorn-encrypted`. The Longhorn `daily-backup` job then copies it to S3 as ciphertext.

**CronJob `money-tracker-pg-dump`:**
- Schedule `30 1 * * *`, so it runs before the 02:00 Longhorn backup.
- Image `ghcr.io/cloudnative-pg/postgresql:17`, label `app: money-tracker-backup`.
- It runs `pg_dump --format=custom` of `money` as the app user (from `money-tracker-db-app`) to `/dumps/money-<date>.dump`, then deletes dumps older than 14 days.
- `concurrencyPolicy: Forbid`, `backoffLimit: 2`, the restricted `securityContext`.

**CronJob `money-tracker-restore-check`:**
- Schedule `0 4 1 * *`, the same image.
- It connects as `money_restore_check` (Task 50) with the password from `money-tracker-pg-restore-check`.
- It creates the database `restore_check`, restores the newest dump with `pg_restore`, and compares `count(*)` of the six synced tables against the live database. The counts may differ only by rows written after the dump time. A restore error or an empty `transactions` table while the live table is not empty counts as a failure.
- It drops `restore_check` at the end, also after a failure, and exits non-zero on failure.

**Alert rule** in `alerts.yaml`: `KubeJobFailed` with `expr: kube_job_status_failed{namespace="money-tracker"} > 0`, `for: 5m`, `severity: warning`, and a description that names the job.

- [ ] **Step 2: Verify after deploy (Task 55)**

Run: `kubectl -n money-tracker create job --from=cronjob/money-tracker-pg-dump dump-now && kubectl -n money-tracker wait --for=condition=complete job/dump-now --timeout=300s && kubectl -n money-tracker create job --from=cronjob/money-tracker-restore-check restore-now && kubectl -n money-tracker wait --for=condition=complete job/restore-now --timeout=600s`
Expected: both jobs complete.

### Task 55: First deploy, smoke test and runbook

**Files:**
- Create: `docs/operations.md` (in this repo, if not created yet)
- Modify: `home-infrastructure/k8s/money-tracker/*.yaml` (image tags)
- Type: both

- [ ] **Step 1: Deploy**

Set the image tags in `api.yaml`, `powersync.yaml` and `web.yaml` to the release tag from Task 48.

Run: `./deploy.sh money-tracker install --dry-run && ./deploy.sh money-tracker install && ./deploy.sh nginx-gateway-fabric upgrade && ./deploy.sh prometheus upgrade`
Expected: no errors. `kubectl -n money-tracker get pods` shows the database, API, PowerSync and two web pods Running. `kubectl -n money-tracker get certificate` shows both certificates Ready.

- [ ] **Step 2: Smoke test**

Run: `curl -fsS https://money.kyosifov.com/api/.well-known/jwks.json && kubectl -n money-tracker exec deploy/money-tracker-api -- /mtapi admin invite --email <your email> --currency EUR`
Expected: the JWKS prints and an invite URL prints. Open the URL, set the password and TOTP, save the recovery codes, add one expense in the browser and on the iPhone, and check that both show it.

- [ ] **Step 3: Write the runbook**

`docs/operations.md` covers:
- Invite a user, reset TOTP and revoke sessions (the `mtapi admin` commands through `kubectl exec`).
- Rotate the JWT key: replace the secret and restart the API and PowerSync. All users then log in again.
- Never rotate `TOTP_ENC_KEY` without a re-encryption step.
- Restore from a dump (scale the API and PowerSync to 0, `pg_restore --clean` into `money`, scale up, then every device runs "Reset local data").
- Restore from a Longhorn backup.
- The release order from Task 48.
- The self-hosted runner setup from Task 47.

---

## Self-review

- **Spec coverage:**
  - Transactions (add, edit, delete, search, filters): Tasks 28, 29, 36, 37.
  - Categories and accounts (create, rename, recolour, reorder, archive, transfers): Tasks 29, 38.
  - Overview, charts and reports (periods, category totals, history, tap-through, text summary): Tasks 22, 28, 35, 39.
  - Optional overall budget and progress: Tasks 28, 35, 40.
  - Offline-first storage, queued sync, sync state, stable IDs, conflict strategy, no duplicates: Tasks 16, 17, 19, 25, 27, 29, 30, 43, 44, 45.
  - Authentication, encryption in transit, server data protection, device loss: Tasks 6 to 14, 41, 49, 52, 53.
  - Backups: Task 54.
  - Accessibility and locale formatting: Tasks 21, 22, 32, 35, 39.
  - Performance with large histories: Tasks 28, 36.
  - Out of scope here, each with its own later plan: CSV import, data export and restore through the UI, salary planning, AI suggestions and bank connections. Task 36 shows Export as disabled.
- **Placeholder scan:** no TBD or TODO. Two steps depend on external docs that must be read at execution time: the PowerSync web asset setup (Task 25) and the PowerSync start command and health path (Task 51). Both say exactly what to look up and how to verify it.
- **Naming:** the Services are `money-tracker-api`, `money-tracker-powersync`, `money-tracker` and `money-tracker-db-rw` everywhere. The roles are `powersync_repl` and `powersync_storage`. The publication is `powersync`. The local-only tables are `device_prefs` and `sync_problems`.
- **Paths:** all paths are relative to the repo root. Infra paths start with `home-infrastructure/`.

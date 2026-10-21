COMPOSE_FILE := deploy/compose/docker-compose.yml
E2E_COMPOSE := docker compose -f $(COMPOSE_FILE) -f deploy/compose/docker-compose.e2e.yml
# The iOS suites install a Release build. Other simulators than the dev ones keep the dev build.
IOS_PHONE_SIMULATOR ?= iPhone 17e
IOS_TABLET_SIMULATOR ?= iPad (A16)

.PHONY: setup generate check-generated test-api test-app test stack-up stack-up-no-otp stack-down e2e-stack-up e2e-stack-down e2e-web e2e-ios e2e-cross

setup:
	./scripts/setup-macos.sh

generate:
	npm --prefix schema/scripts ci --no-audit --no-fund --silent
	node schema/scripts/generate.mjs

check-generated: generate
	git diff --exit-code app/src/generated api/internal/schema/types_gen.go api/internal/schema/json

test-api:
	go -C api test ./...

test-app:
	npm --workspace app test

test: test-api test-app

stack-up:
	docker compose -f $(COMPOSE_FILE) up -d --build --wait

stack-up-no-otp:
	DISABLE_TOTP=true docker compose -f $(COMPOSE_FILE) up -d --build --wait

stack-down:
	docker compose -f $(COMPOSE_FILE) down -v

# The e2e stack has its own database. The suites delete its data, never the dev data.
e2e-stack-up:
	$(E2E_COMPOSE) up -d --build --wait

e2e-stack-down:
	$(E2E_COMPOSE) down -v

e2e-web:
	npm --workspace e2e run test:web

e2e-ios:
	IOS_PHONE_SIMULATOR="$(IOS_PHONE_SIMULATOR)" IOS_TABLET_SIMULATOR="$(IOS_TABLET_SIMULATOR)" npm --workspace e2e run test:ios

e2e-cross:
	IOS_PHONE_SIMULATOR="$(IOS_PHONE_SIMULATOR)" npm --workspace e2e run test:cross

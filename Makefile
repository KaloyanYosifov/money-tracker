COMPOSE_FILE := deploy/compose/docker-compose.yml

.PHONY: generate check-generated test-api test-app test stack-up stack-down e2e-web

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

stack-down:
	docker compose -f $(COMPOSE_FILE) down -v

e2e-web:
	npm --workspace e2e run test:web

#!/usr/bin/env bash
# Creates the dev user in the local stack if it does not exist.
# The stack must run with DISABLE_TOTP=true, because the invite confirm step sends no real TOTP code.
set -euo pipefail

email="dev@example.com"
password="devpassword"
api_url="http://localhost:8088/api"
compose=(docker compose -f "$(cd "$(dirname "$0")/.." && pwd)/deploy/compose/docker-compose.yml")

exists="$("${compose[@]}" exec -T postgres psql -U money -d money -tAc \
  "SELECT 1 FROM users WHERE email = '$email' AND totp_enabled")"
if [ "$exists" = "1" ]; then
  echo "Dev user $email exists."
  exit 0
fi

invite_url="$("${compose[@]}" exec -T api /mtapi admin invite --email "$email" --currency EUR --role admin)"
token="${invite_url##*token=}"

curl -fsS -o /dev/null -X POST "$api_url/auth/invite/accept" \
  -H "Content-Type: application/json" -H "X-Client: native" \
  -d "{\"token\":\"$token\",\"password\":\"$password\"}"
if ! curl -fsS -o /dev/null -X POST "$api_url/auth/invite/confirm" \
  -H "Content-Type: application/json" -H "X-Client: native" \
  -d "{\"token\":\"$token\",\"code\":\"000000\",\"device_name\":\"dev seed\"}"; then
  echo "Error: the invite confirm failed. If the API runs with TOTP on, start the stack with make stack-up-no-otp." >&2
  exit 1
fi

echo "Created dev user $email with password $password."

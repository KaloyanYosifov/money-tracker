#!/usr/bin/env bash
# Creates an invite in the local stack and prints the invite URL.
set -euo pipefail

compose_file="$(cd "$(dirname "$0")/.." && pwd)/deploy/compose/docker-compose.yml"

read -rp "Email: " email
if [ -z "$email" ]; then
  echo "Error: the email is required." >&2
  exit 1
fi
read -rp "Currency [EUR]: " currency
read -rp "Role (user|admin) [user]: " role

docker compose -f "$compose_file" exec -T api /mtapi admin invite \
  --email "$email" --currency "${currency:-EUR}" --role "${role:-user}"

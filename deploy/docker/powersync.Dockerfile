# syntax=docker/dockerfile:1
# Build context: the repository root.
# The service config is mounted from a secret at run time.
FROM journeyapps/powersync-service:1.27.0
COPY sync/sync-rules.yaml /config/sync-rules.yaml

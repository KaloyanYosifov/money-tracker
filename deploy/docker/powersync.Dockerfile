# syntax=docker/dockerfile:1
# Build context: the repository root.
# The service config is mounted from a secret at run time.
FROM journeyapps/powersync-service:1.28.3
# The base image can lag behind the Alpine security fixes.
USER root
RUN apk upgrade --no-cache
USER 901
COPY sync/sync-rules.yaml /config/sync-rules.yaml

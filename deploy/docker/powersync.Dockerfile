# syntax=docker/dockerfile:1
# Build context: the repository root.
# The service config is mounted from a secret at run time.
FROM journeyapps/powersync-service:1.27.1
# The service starts with node directly. The bundled npm CLI is not used and has known CVEs.
USER root
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER 901
COPY sync/sync-rules.yaml /config/sync-rules.yaml

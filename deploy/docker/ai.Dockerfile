# syntax=docker/dockerfile:1
# Build context: the repository root.
# Dependabot updates the image digests. The claude-cli-update workflow updates
# CLAUDE_VERSION and the checksums.
FROM --platform=$BUILDPLATFORM golang:1.26.10@sha256:672c944cfd07599b5f1bb179869270cdc94c6254e41db4d431259693cb286b82 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/ai
COPY ai/go.mod ./
RUN go mod download
COPY ai/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/mtai ./cmd/mtai

# The checksums come from
# https://downloads.claude.ai/claude-code-releases/<version>/manifest.json.
FROM debian:12-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS cli
ARG TARGETARCH
ARG CLAUDE_VERSION=2.1.311
ARG CLAUDE_SHA256_AMD64=86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada
ARG CLAUDE_SHA256_ARM64=2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) platform=linux-x64; sum="$CLAUDE_SHA256_AMD64" ;; \
      arm64) platform=linux-arm64; sum="$CLAUDE_SHA256_ARM64" ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /claude \
      "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${platform}/claude"; \
    echo "${sum}  /claude" | sha256sum -c -; \
    chmod 0755 /claude

# Not distroless: the Claude CLI needs a shell and glibc.
FROM debian:12-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /bin/bash mtai
COPY --from=cli /claude /usr/local/bin/claude
COPY --from=build /out/mtai /mtai
USER mtai
WORKDIR /home/mtai
ENV DISABLE_AUTOUPDATER=1
EXPOSE 8080
ENTRYPOINT ["/mtai"]

# syntax=docker/dockerfile:1
# Build context: the repository root.
# Dependabot updates the image digests. The claude-cli-update workflow updates
# CLAUDE_VERSION and the checksums.
FROM --platform=$BUILDPLATFORM golang:1.26.11@sha256:4165ee6bf3b7811fd7b40373290405c83d0167dcb87ee5f29c427cdcef45ff8f AS build
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
ARG CLAUDE_VERSION=2.1.323
ARG CLAUDE_SHA256_AMD64=604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e
ARG CLAUDE_SHA256_ARM64=452dddff140b5caf00a5410333a3d6db82c73ea2dec74b1541fae18e97d47dca
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
# The base image can lag behind the Debian security fixes.
RUN apt-get update \
    && apt-get upgrade -y \
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

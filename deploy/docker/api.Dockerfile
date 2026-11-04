# syntax=docker/dockerfile:1
# Build context: the repository root.
FROM --platform=$BUILDPLATFORM golang:1.27.3 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/api
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/mtapi ./cmd/mtapi

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mtapi /mtapi
EXPOSE 8080
ENTRYPOINT ["/mtapi"]
CMD ["serve"]

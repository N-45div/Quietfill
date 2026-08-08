# Self-contained build of tee-proxy. Clones tee-proxy from GitHub at build time
# so no local sibling repos are needed.
#
# TEE_PROXY_VERSION MUST stay aligned with the extension's Go-module pins
# (tools/go.mod). The pin is a pseudo-version whose last segment is the commit
# SHA (0c6d016b0994, the develop commit aligned with tee-node v0.0.23 — the
# pairing confirmed working on Coston2). tee-proxy's own go.mod transitively
# pins the matching tee-node and go-flare-common line, so building it with
# `go mod download` pulls the exact governance-aware node code the
# extension-tee image uses. Override via build arg when bumping both sides
# together.

ARG TEE_PROXY_VERSION=v0.0.21-0.20260729123751-0c6d016b0994

# NOTE: not pinned by digest (unlike the main Dockerfile) — this is a dev convenience build.
FROM golang:1.25.1-alpine AS builder

RUN apk add --no-cache git

ARG TEE_PROXY_VERSION

# The pinned tee-proxy requires a newer Go patch than the base image carries;
# GOTOOLCHAIN=auto lets go fetch the toolchain the module demands.
ENV GOTOOLCHAIN=auto

# A pseudo-version's SHA is not a git tag, so resolve it with a blobless clone
# and checkout (tags pass through unchanged).
WORKDIR /app
RUN git clone --filter=blob:none https://github.com/flare-foundation/tee-proxy.git tee-proxy && \
    cd tee-proxy && \
    REF="$(echo "${TEE_PROXY_VERSION}" | grep -oE '[0-9a-f]{12}$' || echo "${TEE_PROXY_VERSION}")" && \
    git checkout "${REF}" && \
    echo "tee-proxy at $(git rev-parse HEAD)"

WORKDIR /app/tee-proxy
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -a -o main ./cmd/proxy

# Final stage
FROM alpine:3.21

WORKDIR /app

COPY --from=builder /app/tee-proxy/main .
# The example config moved into config/ at commit 0c6d016.
COPY --from=builder /app/tee-proxy/config/config.example.toml ./config/config.toml

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 6661
EXPOSE 6662

CMD ["./main"]

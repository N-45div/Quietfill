# Single-container QuietFill FCC stack for Render's free tier: redis +
# tee-proxy + tee-node + the TypeScript extension + a node CORS edge, all on
# localhost so no inter-service networking is needed. Build context is the
# repo root:
#
#   docker build -f deploy/render/Dockerfile -t quietfill-fcc .
#
# Pins mirror the scaffold: tee-node v0.0.23 + tee-proxy at commit
# 0c6d016b0994 — the aligned pair confirmed relaying on Coston2.

# --- tee-node server binary --------------------------------------------------
FROM golang:1.25.1-trixie AS teenode

ARG TEE_NODE_REF=v0.0.23
ENV GOTOOLCHAIN=auto
WORKDIR /build
RUN git clone --filter=blob:none https://github.com/flare-foundation/tee-node.git tee-node && \
    cd tee-node && git checkout "${TEE_NODE_REF}"
WORKDIR /build/tee-node
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/extension
RUN cp assets/google_confidential_space_root.crt /out/google_confidential_space_root.crt

# --- tee-proxy binary --------------------------------------------------------
FROM golang:1.25.1-alpine AS teeproxy

RUN apk add --no-cache git
ARG TEE_PROXY_VERSION=v0.0.21-0.20260729123751-0c6d016b0994
ENV GOTOOLCHAIN=auto
WORKDIR /build
RUN git clone --filter=blob:none https://github.com/flare-foundation/tee-proxy.git tee-proxy && \
    cd tee-proxy && \
    REF="$(echo "${TEE_PROXY_VERSION}" | grep -oE '[0-9a-f]{12}$' || echo "${TEE_PROXY_VERSION}")" && \
    git checkout "${REF}"
WORKDIR /build/tee-proxy
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -a -o /out/main ./cmd/proxy

# --- extension ---------------------------------------------------------------
FROM node:22-trixie AS ext

WORKDIR /ext
COPY typescript/package.json typescript/package-lock.json ./
RUN npm ci
COPY typescript/tsconfig.json ./
COPY typescript/src/ ./src/
RUN npm run build && npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM debian:trixie-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates nodejs redis-server && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=teenode --chmod=755 /out/server /app/server
COPY --from=teenode /out/google_confidential_space_root.crt /app/assets/google_confidential_space_root.crt
COPY --from=teeproxy --chmod=755 /out/main /app/proxy/main
COPY --from=ext /ext/dist /app/extension/dist
COPY --from=ext /ext/node_modules /app/extension/node_modules
COPY --from=ext /ext/package.json /app/extension/package.json
COPY --chmod=644 deploy/render/edge.js /app/edge.js
COPY --chmod=755 deploy/render/boot.sh /app/boot.sh

ENV PORT=10000
EXPOSE 10000

CMD ["/bin/bash", "/app/boot.sh"]

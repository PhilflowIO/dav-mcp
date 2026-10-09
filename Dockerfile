# syntax=docker/dockerfile:1

# Stage 1: install production dependencies. Alpine provides npm.
# Base images are pinned by digest: tags are mutable and can be repointed at a
# different image without any change in this repo (CVE-2025-30066 precedent).
# The digest must be the multi-arch index, not a per-platform manifest: a
# manifest digest resolves to that one architecture on every platform.
# The stage runs on the build host ($BUILDPLATFORM) for every target: the
# production dependencies are pure JavaScript (no native .node addons), so
# node_modules is platform-independent and npm ci never runs under emulation.
# Pulled from the Docker Official Images mirror on ECR Public, not Docker Hub:
# Docker Hub limits anonymous pulls per IP, and CI runners share their IPs, so
# builds failed with 429 (#140). The digest is the same index, so the bytes are
# too.
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
# Copy package files
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Stage 2: minimal runtime image (distroless: non-root user, no shell, no package manager).
# Non-root is provided by the distroless :nonroot variant (uid 65532).
# Base image pinned by its multi-arch index digest (non-semver tag, but digest
# pinning keeps it reproducible).
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
# Runtime config via env vars; NODE_ENV selects Express production mode.
# Overridable at runtime: PORT (default 3000), BEARER_TOKEN, CALDAV_SERVER_URL,
# CALDAV_USERNAME, CALDAV_PASSWORD, CORS_ALLOWED_ORIGINS.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Copy source code
COPY src ./src

EXPOSE 3000

# Health check (exec form; no shell in distroless). node is not on PATH in
# distroless, so the absolute binary path is required.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"]

# Start server (HTTP mode for Docker/remote deployments)
CMD ["src/server-http.js"]

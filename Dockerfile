# syntax=docker/dockerfile:1

# Stage 1: install production dependencies. Alpine provides npm.
# Base images are pinned by digest: tags are mutable and can be repointed at a
# different image without any change in this repo (CVE-2025-30066 precedent).
FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c AS deps
WORKDIR /app
RUN apk add --no-cache git
# Copy package files
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Stage 2: minimal runtime image (distroless: non-root user, no shell, no package manager).
# Non-root is provided by the distroless :nonroot variant (uid 65532).
# Base image pinned by digest (non-semver tag, but digest pinning keeps it reproducible).
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

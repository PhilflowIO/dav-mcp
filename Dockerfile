# syntax=docker/dockerfile:1

# Stage 1: install production dependencies. Alpine provides npm and the git
# required by the tsdav/tsdav-utils git dependencies in package.json.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache git
# Copy package files
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Stage 2: minimal runtime image (distroless: non-root user, no shell, no package manager).
# Non-root is provided by the distroless :nonroot variant (uid 65532).
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
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
    CMD ["/nodejs/bin/node", "-e", "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"]

# Start server (HTTP mode for Docker/remote deployments)
CMD ["src/server-http.js"]

# ============================================
# ECF Admin (Next.js 16) — standalone output
# Served at the domain ROOT on port 3001; the API lives under /api and /fe on
# the SAME domain (Nginx routes them). Multi-stage for a small, self-contained
# image (no node_modules install at runtime).
# ============================================

# --- Stage 1: deps (install everything needed to build) ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: build (produce .next/standalone) ---
FROM node:22-slim AS build
WORKDIR /app

# NEXT_PUBLIC_* vars are INLINED at build time, so the API base URL must be set
# HERE. Default is the same-origin relative path '/api/v1' (Nginx proxies /api
# to the backend). Override the build-arg only if the API moves off-domain.
ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Stage 3: runner (minimal standalone server) ---
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nextjs

# Standalone output: server.js + minimal node_modules. `static` and `public` are
# NOT bundled by the standalone tracer, so copy them into the locations the
# minimal server.js serves them from.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3001

# Node-only healthcheck (node:22-slim has no wget/curl). /login is a public route.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/login',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

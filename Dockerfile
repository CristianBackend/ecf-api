# ============================================
# ECF-API Dockerfile
# Multi-stage build for NestJS + Prisma
# ============================================

# --- Stage 1: Dependencies ---
FROM node:22-slim AS deps

# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD prevents puppeteer from downloading its
# own Chromium during npm ci. We use the system chromium in production instead.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

# --- Stage 2: Build ---
FROM node:22-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY . .

RUN npm run build
RUN npm prune --production
RUN npx prisma generate

# --- Stage 3: Production ---
FROM node:22-slim AS production

WORKDIR /app

# ⚠️ REBUILD REQUIRED when this layer changes.
# Chromium + system libs needed by puppeteer for server-side PDF generation.
# On node:22-slim (Debian Bookworm): chromium binary is at /usr/bin/chromium.
RUN apt-get update -y && apt-get install -y \
    openssl dumb-init wget libxml2-utils \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Tell puppeteer to use the system Chromium instead of downloading its own.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN groupadd -g 1001 ecfapi && useradd -u 1001 -g ecfapi -m ecfapi

COPY --from=build --chown=ecfapi:ecfapi /app/dist ./dist
COPY --from=build --chown=ecfapi:ecfapi /app/node_modules ./node_modules
COPY --from=build --chown=ecfapi:ecfapi /app/package.json ./
COPY --from=build --chown=ecfapi:ecfapi /app/prisma ./prisma
COPY --chown=ecfapi:ecfapi xsd/*.xsd ./xsd/

USER ecfapi

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD wget -qO- http://localhost:3000/api/v1/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]

# ALO Learning Journey — Production Dockerfile (multi-stage)
# Aligned with CI & production: Node 22, package-lock.json (npm ci), port 3061.

# ---- Stage 1: deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---- Stage 2: build ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    espeak \
    fonts-dejavu-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npx prisma generate
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3061
ENV HOSTNAME=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    espeak \
    fonts-dejavu-core \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* && \
    useradd -r -u 1001 -g root alo

# Copy standalone server (already includes .next/static, public, scripts, and release SHA)
COPY --from=builder --chown=alo:root /app/.next/standalone ./
COPY --from=builder --chown=alo:root /app/prisma ./prisma
COPY --from=builder --chown=alo:root /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=alo:root /app/node_modules/@prisma ./node_modules/@prisma

# Storage volumes (mounted at runtime)
RUN mkdir -p /app/db /app/storage && chown -R alo:root /app/db /app/storage
VOLUME ["/app/storage", "/app/public/generated", "/app/public/avatars", "/app/public/avatar-videos", "/app/public/avatar-audio", "/app/public/avatar-scenes", "/app/public/avatar-thumbs"]

USER alo
EXPOSE 3061
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://127.0.0.1:3061/api/health || exit 1

CMD ["node", "server.js"]

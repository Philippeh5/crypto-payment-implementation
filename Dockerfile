# ──────────────────────────────────────────────
# Multi-stage Dockerfile for crypto-payment-starter-kit
# ──────────────────────────────────────────────

# ── Builder stage ──
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies (including dev for build)
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# ── Runner stage ──
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S -u 1001 -G appgroup appuser

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built output from builder
COPY --from=builder /app/dist ./dist

# Copy schema for migrations (optional, can use mounted volume)
COPY src/db/schema.sql ./src/db/schema.sql

# Change ownership
RUN chown -R appuser:appgroup /app

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

EXPOSE 3000

CMD ["node", "dist/index.js"]
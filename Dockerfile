# Bun runtime for lowest latency on Railway
# Bun has ~2-3x faster HTTP requests and startup vs Node.js
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Railway sets PORT env var; bot doesn't need it but Express webhook does
ENV NODE_ENV=production

# Run copytrade bot directly with Bun (no build step needed)
CMD ["bun", "run", "src/copytrade/index.ts"]

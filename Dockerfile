# Use Node.js LTS as base image
FROM node:20-slim

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci && npm cache clean --force

# Install TypeScript and ts-node globally for runtime compilation
RUN npm install -g typescript ts-node @types/node

# Copy source code
COPY src/ ./src/

# Create data directories
RUN mkdir -p /data/ethereum_1h_data

# Set default DATA_DIR environment variable
ENV DATA_DIR=/data

# Set environment variables for data directories
ENV NODE_ENV=production

# Expose port (if needed for health checks)
EXPOSE 8080

# Health check script - check if process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('fs').accessSync('/data/ethereum_1h_data', fs.constants.F_OK) && process.exit(0) || process.exit(1)"

# Start Ethereum 1h collector script
CMD ["node", "--max-old-space-size=4096", "--expose-gc", "-r", "ts-node/register", "src/scripts/ethereum1hMarketCollector.ts"]

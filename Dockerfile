FROM node:20-alpine

WORKDIR /app

# Install bun globally
RUN npm install -g bun

# Copy package files
COPY package.json bun.lock ./

# Install dependencies using bun
RUN bun install --frozen-lockfile

# Copy application files
COPY . .

# Create configs directory with proper permissions
RUN mkdir -p configs && chmod 700 configs

# Expose port
EXPOSE 7001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["bun", "start"]


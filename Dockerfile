# ─── Stage: Build & Run ────────────────────────────────────────────────────────
FROM node:20-alpine

# Set the working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install Node dependencies (production only, skip devDeps)
RUN npm ci --omit=dev

# Copy the application source
COPY . .

# Expose the application port
EXPOSE 8080

# Start the application
CMD ["node", "server.js"]

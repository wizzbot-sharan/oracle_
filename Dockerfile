FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm ci

# Ensure matching browser binaries and dependencies are installed
RUN npx playwright install chromium --with-deps

# Copy application source
COPY . .

# Build the Vite React frontend
RUN npm run build

# Default environment variables
ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=4100

EXPOSE 4100

# Start Express server (serving API + static frontend)
CMD ["node", "src/server.js"]

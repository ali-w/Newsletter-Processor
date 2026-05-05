# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
# Use npm install safely if package-lock is missing
RUN npm install

# Copy source code and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production Stage
FROM node:22-alpine AS runner

WORKDIR /app

# We only need production dependencies in the final image
COPY package.json ./
RUN npm install --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Use a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8080

CMD ["npm", "start"]

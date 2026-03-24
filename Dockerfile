FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
COPY prisma ./prisma/

# Alpine runtime libraries required by Prisma on musl
RUN apk add --no-cache openssl libgcc libstdc++ gcompat libc6-compat

# Generate client (must be done with dev deps present)
RUN npx prisma generate

# Remove dev deps for runtime
RUN npm prune --production

# Copy entrypoint and make it executable
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 10000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

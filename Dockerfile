FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN apk add --no-cache openssl libgcc libstdc++ gcompat
RUN npx prisma generate
RUN npm prune --production

EXPOSE 5000

CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]

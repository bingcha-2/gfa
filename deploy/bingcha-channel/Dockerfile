FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/bingcha.db
ENV NODE_NO_WARNINGS=1
WORKDIR /app
COPY server.mjs db.mjs admin-cli.mjs ./
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

FROM node:20-bookworm-slim AS build
WORKDIR /app

ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV APP_CONFIG_PATH=/app/data/app-config.json
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci \
  && node node_modules/playwright/cli.js install chromium \
  && npm prune --omit=dev \
  && mkdir -p /app/data

COPY --from=build /app/dist ./dist
COPY server ./server
COPY demo-content ./demo-content

EXPOSE 3000
CMD ["node", "server/proxy.js"]

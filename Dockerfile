FROM node:20-bookworm-slim AS build
WORKDIR /app

ARG VITE_BACKEND_URL
ARG APP_VERSION=0.0.16
ARG APP_COMMIT=unknown
ARG APP_BUILD_TIME=unknown
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ARG APP_VERSION=0.0.16
ARG APP_COMMIT=unknown
ARG APP_BUILD_TIME=unknown
ENV NODE_ENV=production
ENV APP_CONFIG_PATH=/app/data/app-config.json
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$APP_COMMIT
ENV APP_BUILD_TIME=$APP_BUILD_TIME

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

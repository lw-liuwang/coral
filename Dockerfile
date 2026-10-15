FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY static/ static/
COPY config.example.yaml config.yaml
ENV CORAL_HOST=0.0.0.0 CORAL_DATA_DIR=/data
VOLUME /data
EXPOSE 8300
CMD ["node", "dist/server.js"]

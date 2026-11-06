# The OpenLakeForge portal image (React Router, server-rendered on Node). OpenLakeForge pins it by digest in
# release/component-catalog.yaml and mounts the cluster's routes at
# /config/routes.json (a ConfigMap) when it deploys.

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# The build stage runs on the runner's own platform: its output (build/) is plain JS that runs on any
# platform, and Vite's native bundler hangs under QEMU, which stalled the arm64 release build.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY . .
RUN npm test && npm run build

FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="openlakeforge-portal" \
      org.opencontainers.image.description="The OpenLakeForge platform portal" \
      org.opencontainers.image.source="https://github.com/OpenLakeForge/openlakeforge-portal" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    OLF_ROUTES_FILE=/config/routes.json
WORKDIR /app
# build/ holds the SSR bundle and the static assets, but react-router-serve (the
# Express server that runs them) is a runtime dependency, so install the
# production dependencies only: no Vite, React Router CLI, TypeScript or test tools.
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY --from=build /app/build ./build
# Runs as nobody with a read-only root filesystem: nothing is written at runtime.
USER 65534:65534
EXPOSE 8080
CMD ["node", "node_modules/.bin/react-router-serve", "build/server/index.js"]

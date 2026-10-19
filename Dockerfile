# The OpenLakeForge portal image. OpenLakeForge pins it by digest in
# release/component-catalog.yaml and mounts the cluster's routes at
# /config/routes.json (a ConfigMap) when it deploys.

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
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
# dist/ is self-contained (astro.config.mjs bundles every server dependency).
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
# Runs as nobody with a read-only root filesystem: nothing is written at runtime.
USER 65534:65534
EXPOSE 8080
CMD ["node", "dist/server/entry.mjs"]

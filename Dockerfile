# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /build
RUN npm install --global pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/wire-schema/package.json packages/wire-schema/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/backend apps/backend
COPY apps/frontend apps/frontend
COPY packages/shared packages/shared
COPY packages/storage packages/storage
COPY packages/ui packages/ui
COPY packages/wire-schema packages/wire-schema
ARG CAELESTIS_BUILD_ID=development
ENV CAELESTIS_BUILD_ID=$CAELESTIS_BUILD_ID CAELESTIS_TARGET=node
RUN pnpm --filter @caelestis/backend... --filter @caelestis/frontend... build
RUN pnpm --filter @caelestis/backend deploy --prod --legacy /output/apps/backend
RUN pnpm --filter @caelestis/frontend deploy --prod --legacy /output/apps/frontend
RUN cp -R apps/frontend/build /output/apps/frontend/build

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ARG CAELESTIS_BUILD_ID=development
LABEL org.opencontainers.image.source="https://github.com/mia-riezebos/Caelestis" \
      org.opencontainers.image.revision=$CAELESTIS_BUILD_ID
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIRECTORY=/data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends --only-upgrade libpcre2-8-0 \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN mkdir /data /objects && chown node:node /data /objects
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

FROM runtime AS backend
COPY --from=build /output/apps/backend ./apps/backend
# The scheduled renderer shares these source modules and dependencies with the frontend.
COPY --from=build /output/apps/frontend/node_modules ./apps/frontend/node_modules
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY apps/frontend/src/lib/social-*.ts apps/frontend/src/lib/archive-history.ts apps/frontend/src/lib/osm-geometry.ts ./apps/frontend/src/lib/
COPY scripts/social-images.mjs scripts/osm-tiles.mjs ./scripts/
CMD ["node", "apps/backend/dist/node/main.js"]

FROM runtime AS frontend
COPY --from=build /output/apps/frontend ./apps/frontend
CMD ["node", "apps/frontend/node/main.mjs"]

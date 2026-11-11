# syntax=docker/dockerfile:1.7
# Built from the repo root (docker buildx build -f apps/gateway/Dockerfile .): by the release workflow, and
# by deploy/compose for the single-file deploy. One image: the API, the MCP server and the browser app at /app.

# The browser app, built once and copied in as static files. pnpm comes from a lockfile (container/pnpm), so npm
# checks it against a hash.
FROM --platform=$BUILDPLATFORM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS web
COPY apps/gateway/container/pnpm /opt/pnpm
RUN npm ci --prefix /opt/pnpm && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@yardhand/web..." --ignore-scripts
COPY apps/web apps/web
RUN pnpm --filter @yardhand/web exec vite build

FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
COPY apps/gateway/container/pnpm /opt/pnpm
RUN npm ci --prefix /opt/pnpm && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
# The kit is vendored in src/kit, so the install needs no other registry
RUN pnpm install --frozen-lockfile --prod --filter "gateway..." --ignore-scripts \
  && rm -rf /root/.local/share/pnpm /root/.cache
COPY apps/gateway apps/gateway
COPY --from=web /repo/apps/web/dist apps/web/dist
WORKDIR /repo/apps/gateway
RUN chmod +x container/entrypoint.sh
# The commit this image was built from, shown in Settings (the release workflow passes it)
ARG GIT_SHA=
ENV PORT=80 STATE_DIR=/state NODE_ENV=production WEB_DIR=/repo/apps/web/dist GATEWAY_BUILD=$GIT_SHA
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/repo/apps/gateway/container/entrypoint.sh"]

# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
COPY packages/formats/package.json packages/formats/
COPY packages/fixtures/package.json packages/fixtures/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @nslib/web build \
  && mkdir -p packages/server/public \
  && cp -r packages/web/dist/. packages/server/public/
RUN pnpm --filter @nslib/server seed -- /demo/library /demo/prod.keys
RUN pnpm --filter @nslib/server deploy --prod /out \
  && mkdir -p /out/public /out/drizzle \
  && cp -r packages/server/public/. /out/public/ \
  && cp -r packages/server/drizzle/. /out/drizzle/

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /demo/library /library/demo
COPY --from=build /demo/prod.keys /app/demo.keys
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && chmod 644 /app/demo.keys

ENV NODE_ENV=production \
    NSLIB_DATA_DIR=/data \
    NSLIB_HOST=0.0.0.0 \
    NSLIB_PORT=8465 \
    NSLIB_TRUST_PROXY=true \
    NSLIB_SEED=true \
    NSLIB_SEED_DIR=/library/demo \
    NSLIB_SEED_KEYS=/app/demo.keys

EXPOSE 8465
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NSLIB_PORT||process.env.PORT||8465)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "src/main.ts"]

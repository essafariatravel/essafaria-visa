# syntax=docker/dockerfile:1
#
# Essafaria Visa OS — production image.
#
#   docker build -t essafaria-visa-os .
#   docker run --rm -p 3000:3000 \
#     -e DATABASE_URL=postgresql://user:pass@host:5432/essafaria \
#     -e ESF_TOKEN_KEY="$(openssl rand -hex 32)" \
#     essafaria-visa-os
#
# The image is deliberately boring: one process (Next.js server), migrations run at
# start (idempotent), no secrets baked in, and it refuses to boot on a broken config
# because the entrypoint runs the same deploy:check the app expects operators to run.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# postgres client + drizzle are runtime deps; devDependencies stay in the build stage
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# no secrets:scan here: it inspects what git would commit, and the build context has
# no .git by design. CI runs it on the checkout (ci/github-actions/ci.yml).
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# migrations + scripts read the schema, so those directories are part of the runtime
# surface, not just build inputs
COPY --from=build /app/package.json /app/next.config.mjs /app/tsconfig.json /app/drizzle.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# non-root, and the media root lives on a volume so uploads survive a re-deploy
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app \
  && mkdir -p /app/media && chown -R app:app /app/media
VOLUME ["/app/media"]
USER app
EXPOSE 3000

# /api/health reports "degraded" (HTTP 503) when a subsystem is misconfigured, so a
# passing probe means the app is actually usable, not merely listening
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
# not `npm run start` — that script pins -p 3000, and this image should honour $PORT
CMD ["sh", "-c", "exec ./node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3000}\""]

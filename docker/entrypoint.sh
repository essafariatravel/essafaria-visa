#!/bin/sh
# Container entrypoint: preflight, migrate, optionally seed, then start the server.
#
#   RUN_DEPLOY_CHECK=1   (default) fail fast on an unusable configuration
#   RUN_MIGRATIONS=1     (default) apply drizzle migrations — they are idempotent and
#                                 additive, so this is safe on every boot of a rolling
#                                 deploy; set it to 0 if your platform has a dedicated
#                                 release phase for migrations
#   RUN_SEED=1           (default off) load the configurable catalogue + demo accounts;
#                                 intended for a fresh staging database only. It is
#                                 idempotent (existing rows are skipped, never overwritten)
set -e

if [ "${RUN_DEPLOY_CHECK:-1}" = "1" ]; then
  echo "[entrypoint] preflight"
  npx --no-install tsx scripts/deploy-check.ts
fi

if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "[entrypoint] migrations"
  npx --no-install tsx scripts/migrate.ts
fi

if [ "${RUN_SEED:-0}" = "1" ]; then
  echo "[entrypoint] seed (idempotent)"
  npx --no-install tsx scripts/seed.ts
fi

echo "[entrypoint] starting: $*"
exec "$@"

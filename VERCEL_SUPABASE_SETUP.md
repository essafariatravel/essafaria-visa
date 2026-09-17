# ESSAFARIA VISA OS — Vercel + Supabase

This package is prepared for a Vercel deployment backed by Supabase PostgreSQL and Supabase Storage.

## Vercel Environment Variables

Required for the database:

- `DATABASE_URL` — preferred. You can also use `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, or `POSTGRES_URL_NON_POOLING`; the app normalizes these aliases.
- `DATABASE_MODE=postgres` (recommended; automatically inferred when a database URL exists).
- `APP_URL` — optional on Vercel; if omitted, the app derives it from `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`.
- `ESF_TOKEN_KEY` — a random secret of at least 32 characters.

For server-side persistent file storage:

- `MEDIA_PROVIDER=supabase`
- `SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=...` (server-only; NEVER expose it with `NEXT_PUBLIC_`)
- `SUPABASE_STORAGE_BUCKET=essafaria-media`

Create the `essafaria-media` private bucket in Supabase Storage before testing uploads.

## First deployment

The Vercel build runs the Drizzle migrations automatically. To create the demo admin and B2B accounts on a fresh database, set these Production variables once:

- `SEED_ADMIN_PASSWORD`
- `SEED_AGENCY_PASSWORD`

Then redeploy. The seed is idempotent and will not overwrite existing rows.

Demo account emails created by the seed are:

- `admin@essafaria.local`
- `owner@saharavoyages.dz`

## Supabase connection choice

For Vercel/serverless, use a Supabase pooled connection. Transaction pooler is appropriate for short-lived serverless functions; if your connection library requires session semantics, use the session pooler. The app keeps its Vercel-side pool at one connection per warm instance.

## Health check

After deployment open:

`https://YOUR_DOMAIN/api/health`

You should see `status: ok`, `databaseMode: postgres`, and the configured storage provider.

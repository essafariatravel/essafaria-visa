# Upload this package to GitHub + Vercel

1. Create/use a GitHub repository for this project.
2. Upload the **contents of this ZIP**, not the ZIP file itself.
3. Import that repository into Vercel.
4. Vercel will use `vercel.json` and run `npm run vercel-build`.
5. In Vercel → Settings → Environment Variables, set the Production values listed in `VERCEL_SUPABASE_SETUP.md`.
6. In Supabase Storage, create a **private** bucket named `essafaria-media`.
7. Set `SUPABASE_SERVICE_ROLE_KEY` only as a Vercel server-side variable. Never prefix it with `NEXT_PUBLIC_`.
8. For a fresh database, also set `SEED_ADMIN_PASSWORD` and `SEED_AGENCY_PASSWORD` and redeploy once.
9. Test `https://YOUR-DOMAIN/api/health`.
10. Test `/login`, `/admin`, and `/agency`.

The app accepts the Supabase/Vercel integration database aliases `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, and `POSTGRES_URL_NON_POOLING` when `DATABASE_URL` is not present. This prevents a common mismatch where Supabase is connected in Vercel but the application only looks for its own `DATABASE_URL` variable.

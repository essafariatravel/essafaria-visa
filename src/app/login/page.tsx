import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { loginAction } from "@/app/admin/actions";
import { getBranding } from "@/lib/config-service";
import { SiteMark } from "@/components/site/mark";

export const dynamic = "force-dynamic";

export default async function LoginPage(props: { searchParams: { error?: string; next?: string } }) {
  const user = await getSessionUser();
  if (user) redirect(user.role === "AGENCY_ADMIN" || user.role === "AGENCY_USER" ? "/agency" : "/admin");
  const branding = await getBranding().catch(() => null);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-brand-secondary)] px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center text-white">
          <SiteMark branding={branding} light />
          <p className="mt-2 text-sm opacity-70">{branding?.tagline ?? "B2B visa operations"}</p>
        </div>
        <form action={loginAction} className="card p-6 shadow-2xl">
          <h1 className="mb-1 text-xl font-bold">Portal sign in</h1>
          <p className="mb-5 text-sm text-slate-500">Agency and staff accounts.</p>
          {props.searchParams.error === "invalid" ? (
            <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              Invalid credentials.
            </p>
          ) : null}
          {props.searchParams.error === "forbidden" ? (
            <p role="alert" className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              Your account cannot open that page.
            </p>
          ) : null}
          <label className="label" htmlFor="email">
            Email
          </label>
          <input id="email" name="email" type="email" required autoComplete="username" className="input mb-4" />
          <label className="label" htmlFor="password">
            Password
          </label>
          <input id="password" name="password" type="password" required autoComplete="current-password" className="input mb-5" />
          {props.searchParams.next ? <input type="hidden" name="next" value={props.searchParams.next} /> : null}
          <button type="submit" className="btn-brand w-full">
            Sign in
          </button>
          <p className="mt-4 text-center text-xs text-slate-400">
            Trouble signing in? Contact your ESSAFARIA account manager.
          </p>
        </form>
      </div>
    </main>
  );
}

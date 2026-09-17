"use client";

import { useEffect } from "react";

/**
 * Last-resort error boundary. The technical detail goes to the browser console
 * for whoever is debugging; the user sees an actionable sentence and a retry —
 * never a stack trace, an SQL fragment or a server path.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[ui] render failed", error?.digest ?? error);
  }, [error]);
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-8 text-center shadow-sm">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-red-600">Something went wrong</p>
        <h1 className="mt-3 text-xl font-bold tracking-tight text-slate-800">This screen could not be drawn</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          Your data is safe — nothing was partially written, because every operation commits or rolls back as a whole. Try again; if it keeps happening,
          quote reference code <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{error?.digest?.slice(0, 12) || "unavailable"}</code> to the ESSAFARIA desk.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => reset()} className="btn-brand text-sm">
            Try again
          </button>
          <a href="/admin" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Back to the desk
          </a>
        </div>
      </div>
    </main>
  );
}

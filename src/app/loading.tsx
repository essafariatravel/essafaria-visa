export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10" aria-busy="true" aria-live="polite">
      <div className="h-7 w-56 animate-pulse rounded bg-slate-200" />
      <div className="mt-3 h-4 w-80 animate-pulse rounded bg-slate-100" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white" />
        ))}
      </div>
      <div className="mt-6 h-64 animate-pulse rounded-xl border border-slate-200 bg-white" />
      <p className="sr-only">Loading</p>
    </div>
  );
}

export function Flash({ searchParams }: { searchParams: { flash?: string } }) {
  if (!searchParams.flash) return null;
  const decoded = decodeURIComponent(searchParams.flash);
  const [kind, ...rest] = decoded.split(":");
  const message = rest.join(":");
  const ok = kind === "ok";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-5 rounded-lg border px-4 py-2.5 text-sm font-medium ${
        ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
      }`}
    >
      {message}
    </div>
  );
}

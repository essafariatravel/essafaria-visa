export function PageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 md:px-6">
      <div className="mb-8 max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl" style={{ color: "var(--color-brand-secondary)" }}>
          {title}
        </h1>
        {subtitle ? <p className="mt-2 text-slate-500">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

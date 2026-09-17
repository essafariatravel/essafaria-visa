import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/admin/ui";
import { Notice, Panel } from "@/components/ops/ui";
import { askCopilot, parseIntent } from "@/lib/ai";
import { staffActorForPage } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

const SUGGESTIONS = [
  "which applications are waiting for documents?",
  "which files have payment problems?",
  "what needs follow-up?",
  "urgent open files",
  "my queue",
  "summarise ESF-2026-000001",
];

/**
 * The desk copilot. Questions map onto prepared, tenant-scoped reads — the text
 * of a question (or of an imported email) never becomes a query.
 */
export default async function CopilotPage({ searchParams }: { searchParams: { q?: string } }) {
  const actor = await staffActorForPage("ai.use");
  const question = (searchParams.q ?? "").trim();
  const answer = question.length >= 3 ? await askCopilot(actor, question).catch((e) => ({ error: (e as Error).message })) : null;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Desk copilot" subtitle="Ask about workload, documents and money. It answers from the same scoped services the screens use, and it can change nothing." />
      <Panel>
        <form action="/admin/copilot" className="flex flex-wrap items-end gap-2">
          <div className="min-w-[280px] flex-1">
            <label className="label" htmlFor="q">
              Question
            </label>
            <input id="q" name="q" defaultValue={question} className="input" placeholder={SUGGESTIONS[0]} />
          </div>
          <button type="submit" className="btn-brand !px-4 !py-2 text-xs">
            Ask
          </button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <Link key={s} href={`/admin/copilot?q=${encodeURIComponent(s)}`} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200">
              {s}
            </Link>
          ))}
        </div>
      </Panel>

      {answer && "error" in (answer as object) ? (
        <div className="mt-4">
          <Notice kind="error">{String((answer as { error: string }).error)}</Notice>
        </div>
      ) : null}

      {answer && "headline" in (answer as object) ? (
        <Panel
          title={(answer as { headline: string }).headline}
          subtitle={`Matched intent: ${(answer as { intent: string }).intent.toLowerCase().replace(/_/g, " ")}${(answer as { refused: boolean }).refused ? " · nothing was run" : ""}`}
        >
          {(answer as { rows: Array<{ reference: string; agency: string; detail: string; href: string }> }).rows.length ? (
            <ul className="divide-y divide-slate-100">
              {(answer as { rows: Array<{ reference: string; agency: string; detail: string; href: string }> }).rows.map((r) => (
                <li key={r.reference} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={r.href} className="text-sm font-semibold text-[var(--color-brand-primary)] hover:underline">
                    {r.reference}
                  </Link>
                  <span className="text-xs text-slate-600">{r.detail}</span>
                  <span className="text-[11px] text-slate-400">{r.agency}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No rows matched" />
          )}
          {(answer as { notes: string[] }).notes.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-4 text-[11px] text-slate-500">
              {(answer as { notes: string[] }).notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}

      {question && answer && "intent" in (answer as object) ? (
        <p className="mt-3 text-[11px] text-slate-400">Parsed as “{parseIntent(question).intent}”.</p>
      ) : null}
    </div>
  );
}

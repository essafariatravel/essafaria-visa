import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb, legalPages } from "@/db";
import { PageShell } from "@/components/site/shell";

export const dynamic = "force-dynamic";

type Block = { type: "h2" | "p" | "li"; text: string };

export default async function LegalPage({ params }: { params: { slug: string } }) {
  const db = await getDb();
  const [page] = await db
    .select()
    .from(legalPages)
    .where(eq(legalPages.slug, params.slug))
    .limit(1);
  // Only published pages are public — draft content never leaks.
  if (!page || page.publishState !== "PUBLISHED") notFound();

  // Group consecutive li blocks into lists.
  const rendered: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (list.length) {
      rendered.push(
        <ul key={key} className="my-4 list-disc space-y-1 pl-6 text-slate-600">
          {list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  page.body.forEach((b, i) => {
    if (b.type === "li") {
      list.push(b.text);
      return;
    }
    flush(`list-${i}`);
    if (b.type === "h2") {
      rendered.push(
        <h2 key={i} className="mb-2 mt-8 text-lg font-bold" style={{ color: "var(--color-brand-secondary)" }}>
          {b.text}
        </h2>,
      );
    } else {
      rendered.push(
        <p key={i} className="my-3 leading-7 text-slate-600">
          {b.text}
        </p>,
      );
    }
  });
  flush("list-end");

  return (
    <PageShell title={page.title} subtitle={page.publishedAt ? `Last updated ${new Date(page.publishedAt).toLocaleDateString()}` : undefined}>
      <article className="max-w-3xl">{rendered}</article>
    </PageShell>
  );
}

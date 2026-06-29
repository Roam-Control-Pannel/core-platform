/**
 * JsonLd — renders a schema.org structured-data block into the page <head>/body as a
 * <script type="application/ld+json">. A server component (no "use client"): the JSON is
 * serialised once on the server and shipped in the initial HTML, which is exactly what
 * crawlers read. Callers pass an object from the builders in lib/seo.ts.
 *
 * We escape "<" in the serialised JSON so a stray "</script>" inside user content can't break
 * out of the script element (the standard JSON-LD injection guard).
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

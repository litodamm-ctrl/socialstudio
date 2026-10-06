import { inspectWebsite, normalizeWebsiteUrls } from "@/lib/website-sources";

export async function POST(request: Request) {
  if (!request.headers.get("oai-authenticated-user-id")) return Response.json({ error: "Inicia sesión para revisar las webs." }, { status: 401 });
  let urls: string[];
  try { const input = await request.json() as { urls?: unknown }; urls = normalizeWebsiteUrls(input?.urls); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Revisa los enlaces." }, { status: 400 }); }
  const results: Array<{ url: string; message: string }> = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
    while (cursor < urls.length) {
      const index = cursor++;
      const result = await inspectWebsite(urls[index]);
      results[index] = { url: urls[index], message: result.page
        ? `Texto accesible · ${result.page.images.length} enlaces de imágenes detectados (descarga pendiente de validar).`
        : result.error || "No se pudo leer la web." };
    }
  }));
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}

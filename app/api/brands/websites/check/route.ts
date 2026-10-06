import { readWebsiteImage } from "@/lib/website-images";
export const maxDuration = 120;
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
      if (!result.page) { results[index] = {url:urls[index],message:result.error || "No se pudo leer la web."}; continue; }
      let valid = 0;
      for (const source of result.page.images.slice(0,8)) {
        try { await readWebsiteImage(source); valid++; } catch { /* Report processed images, not only links. */ }
        if (valid >= 3) break;
      }
      const embedded = result.page.images.filter(source => source.startsWith("data:")).length;
      results[index] = {url:urls[index], message:`Texto accesible · ${result.page.images.length} imágenes detectadas (${embedded} incrustadas) · ${valid ? `${valid} fotografías verificadas para el agente` : "ninguna superó la validación de formato, tamaño y acceso"}.`};
    }
  }));
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}

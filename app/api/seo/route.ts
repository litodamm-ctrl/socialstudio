import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";
import { brandOwned, ensureSeo, queueSeo, seoSettings } from "@/lib/seo";
import { googleConfigured, googleResources } from "@/lib/seo-google";
import { storedWebsiteUrls } from "@/lib/website-sources";
import { launchBackground } from "@/lib/netlify-jobs";

export async function GET(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  try {
    await ensureDefaultBrands(env.DB, owner); await ensureSeo(env.DB);
    const brands = await env.DB.prepare("SELECT id, name, color, initials, website_url, website_urls FROM brand_registry WHERE owner_id = ? AND active = 1 ORDER BY created_at").bind(owner).all();
    const connected = Boolean(await env.DB.prepare("SELECT owner_id FROM seo_google WHERE owner_id = ?").bind(owner).first());
    const id = new URL(request.url).searchParams.get("brandId");
    let settings = null; let runs: unknown[] = [];
    if (id) {
      if (!await brandOwned(env.DB, owner, id)) return Response.json({ error: "Marca no encontrada." }, { status: 404 });
      settings = await seoSettings(env.DB, owner, id);
      const rows = await env.DB.prepare("SELECT id, status, started_at, finished_at, report, error FROM seo_runs WHERE owner_id = ? AND brand_id = ? ORDER BY started_at DESC LIMIT 10").bind(owner, id).all<{ id: string; status: string; started_at: number; finished_at: number | null; report: string | null; error: string | null }>();
      runs = (rows.results ?? []).map(r => ({ ...r, report: r.report ? JSON.parse(r.report) : null }));
    }
    return Response.json({ brands: brands.results ?? [], settings, runs, google: { connected, configured: googleConfigured() }, agent: Boolean(env.OPENAI_API_KEY), scheduler: Boolean(env.SITE_ORIGIN && process.env.CRON_SECRET) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "No se pudo cargar SEO. Revisa la conexión con la base de datos." }, { status: 503 }); }
}
export async function POST(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  try {
    const input = await request.json() as Record<string, unknown>;
    if (typeof input.brandId !== "string") return Response.json({ error: "Elige una marca." }, { status: 400 });
    await ensureSeo(env.DB);
    const brand = await brandOwned(env.DB, owner, input.brandId);
    if (!brand) return Response.json({ error: "Marca no encontrada." }, { status: 404 });
    const current = await seoSettings(env.DB, owner, brand.id);
    if (input.action === "run") {
      if (!env.SITE_ORIGIN || !process.env.CRON_SECRET) return Response.json({ error: "Configura SITE_ORIGIN y CRON_SECRET en Netlify para ejecutar auditorías en segundo plano." }, { status: 409 });
      const run = await queueSeo(env.DB, brand);
      try { await launchBackground("seo-background", { runId: run.id }); }
      catch {
        await env.DB.prepare("UPDATE seo_runs SET status = 'failed', error = 'No se pudo iniciar el proceso en Netlify.', finished_at = ? WHERE id = ? AND status = 'queued'").bind(Date.now(), run.id).run();
        await env.DB.prepare("UPDATE seo_settings SET lease_until = 0 WHERE brand_id = ? AND owner_id = ?").bind(brand.id, owner).run();
        return Response.json({ error: "No se pudo iniciar el proceso. Comprueba que seo-background esté desplegada en Netlify." }, { status: 503 });
      }
      return Response.json({ queued: true, runId: run.id }, { status: 202 });
    }
    if (input.action !== "save") return Response.json({ error: "Acción no válida." }, { status: 400 });
    if (typeof input.enabled !== "boolean" || !["daily", "weekly"].includes(String(input.cadence)) || typeof input.keywords !== "string" || input.keywords.length > 2000 || typeof input.location !== "string" || input.location.length > 200 || typeof input.searchProperty !== "string" || input.searchProperty.length > 2048 || typeof input.googleLocation !== "string" || input.googleLocation.length > 300) return Response.json({ error: "Revisa los campos del agente." }, { status: 400 });
    if (input.enabled && !storedWebsiteUrls(brand.website_urls, brand.website_url).length) return Response.json({ error: "Agrega al menos una web de esta marca antes de activar el agente." }, { status: 409 });
    if (input.enabled && (!env.SITE_ORIGIN || !process.env.CRON_SECRET)) return Response.json({ error: "Configura las tareas programadas en Netlify antes de activar el agente." }, { status: 409 });
    if ((input.searchProperty && input.searchProperty !== current.search_property) || (input.googleLocation && input.googleLocation !== current.google_location)) {
      const resources = await googleResources(env.DB, owner);
      if (input.searchProperty && !resources.properties.some(p => p.siteUrl === input.searchProperty)) return Response.json({ error: "Esta propiedad no está autorizada en tu cuenta de Google." }, { status: 400 });
      if (input.googleLocation && !resources.locations.some(l => l.name === input.googleLocation)) return Response.json({ error: "Esta ubicación no está autorizada en tu cuenta de Google." }, { status: 400 });
    }
    await env.DB.prepare("UPDATE seo_settings SET enabled = ?, cadence = ?, keywords = ?, location = ?, search_property = ?, google_location = ? WHERE brand_id = ? AND owner_id = ?")
      .bind(input.enabled ? 1 : 0, input.cadence, input.keywords.trim(), input.location.trim(), input.searchProperty, input.googleLocation, brand.id, owner).run();
    return Response.json({ saved: true });
  } catch (e) { return Response.json({ error: e instanceof SyntaxError ? "Solicitud no válida." : e instanceof Error && /Agrega|proceso/.test(e.message) ? e.message : "No se pudo completar la acción SEO." }, { status: 400 }); }
}

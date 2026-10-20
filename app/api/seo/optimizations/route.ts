import { env } from "@/lib/runtime";
import { brandOwned, ensureSeo } from "@/lib/seo";
import { deliverySettings, listSeoProposals, proposalText, queueSeoProposal, verifySeoProposal, type SeoProposal } from "@/lib/seo-optimizations";
import { githubConfigured, parseGithubTargets } from "@/lib/seo-github";
import { storedWebsiteUrls } from "@/lib/website-sources";
import { launchBackground } from "@/lib/netlify-jobs";
import { validateGoogleBusinessDescription } from "@/lib/seo-google";

export async function GET(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  try {
    await ensureSeo(env.DB);
    const brand = await brandOwned(env.DB, owner, new URL(request.url).searchParams.get("brandId") ?? "");
    if (!brand) return Response.json({ error: "Marca no encontrada." }, { status: 404 });
    return Response.json({ delivery: await deliverySettings(env.DB, brand), proposals: await listSeoProposals(env.DB, owner, brand.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "No se pudieron cargar las mejoras." }, { status: 503 }); }
}
export async function POST(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  try {
    const input = await request.json() as Record<string, unknown>;
    await ensureSeo(env.DB);
    if (typeof input.brandId !== "string") return Response.json({ error: "Elige una marca." }, { status: 400 });
    const brand = await brandOwned(env.DB, owner, input.brandId);
    if (!brand) return Response.json({ error: "Marca no encontrada." }, { status: 404 });
    if (input.action === "destinations") {
      if (typeof input.autoPr !== "boolean") throw new Error("Revisa el modo de automatización.");
      const targets = parseGithubTargets(input.githubTargets, storedWebsiteUrls(brand.website_urls, brand.website_url));
      if (input.autoPr && (!githubConfigured() || !targets.length)) throw new Error("Conecta GitHub y agrega al menos un destino antes de activar el envío automático.");
      await env.DB.prepare("INSERT OR IGNORE INTO seo_delivery (brand_id, owner_id) VALUES (?,?)").bind(brand.id, owner).run();
      const changed = await env.DB.prepare("UPDATE seo_delivery SET github_targets = ?, auto_pr = ?, revision = revision + 1 WHERE brand_id = ? AND owner_id = ? AND NOT EXISTS (SELECT 1 FROM seo_proposals p WHERE p.owner_id = seo_delivery.owner_id AND p.brand_id = seo_delivery.brand_id AND p.status IN ('queued','processing')) RETURNING brand_id")
        .bind(JSON.stringify(targets), input.autoPr ? 1 : 0, brand.id, owner).first();
      if (!changed) throw new Error("Espera a que termine el envío en curso antes de cambiar sus destinos.");
      return Response.json({ saved: true });
    }
    if (typeof input.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id)) throw new Error("Selecciona una propuesta válida.");
    const item = await env.DB.prepare("SELECT * FROM seo_proposals WHERE id = ? AND owner_id = ? AND brand_id = ?").bind(input.id, owner, brand.id).first<SeoProposal>();
    if (!item) return Response.json({ error: "Propuesta no encontrada." }, { status: 404 });
    if (input.action === "edit") {
      const title = item.kind === "github" ? proposalText(input.title, 150) : item.title;
      const description = proposalText(input.description, item.kind === "github" ? 320 : 750);
      if (item.kind === "google") validateGoogleBusinessDescription(description);
      // A failed delivery may have reached the provider. Keep that exact payload retryable.
      const saved = await env.DB.prepare("UPDATE seo_proposals SET title = ?, description = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND brand_id = ? AND status = 'draft' RETURNING id").bind(title, description, Date.now(), item.id, owner, brand.id).first();
      if (!saved) throw new Error("Solo se pueden editar borradores que aún no se hayan enviado.");
    } else if (input.action === "dismiss") {
      const changed = await env.DB.prepare("UPDATE seo_proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND owner_id = ? AND brand_id = ? AND status IN ('draft','failed','pr_created') RETURNING id").bind(Date.now(), item.id, owner, brand.id).first();
      if (!changed) throw new Error("No se puede archivar una propuesta en proceso o aplicada.");
    } else if (input.action === "apply") {
      if (!process.env.CRON_SECRET || !env.SITE_ORIGIN) throw new Error("Configura el proceso en segundo plano en Netlify.");
      await queueSeoProposal(env.DB, brand, item.id);
      try { await launchBackground("seo-background", { proposalId: item.id }); }
      catch { /* The scheduler recovers queued work; do not mark a possibly accepted delivery as failed. */ }
      return Response.json({ queued: true }, { status: 202 });
    } else if (input.action === "verify") {
      await verifySeoProposal(env.DB, owner, brand, item.id);
    } else if (input.action === "restore") {
      if (item.kind !== "google" || item.status !== "applied") throw new Error("Solo se puede restaurar una descripción aplicada en Google.");
      const id = (await import("node:crypto")).createHash("sha256").update(`restore:${item.id}`).digest("hex");
      await env.DB.prepare("INSERT OR IGNORE INTO seo_proposals (id,owner_id,brand_id,run_id,kind,target,title,description,before_value,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, owner, brand.id, item.run_id, "google", item.target, "Restaurar descripción anterior", item.before_value, item.description, Date.now(), Date.now()).run();
      await queueSeoProposal(env.DB, brand, id);
      try { await launchBackground("seo-background", { proposalId: id }); } catch {}
      return Response.json({ queued: true }, { status: 202 });
    } else throw new Error("Acción no válida.");
    return Response.json({ saved: true });
  } catch (e) {
    const message = e instanceof SyntaxError ? "Solicitud no válida." : e instanceof Error ? e.message : "No se pudo completar la mejora.";
    // Database failures can include SQL/implementation detail; never return those bodies.
    return Response.json({ error: /D1|SQLITE|constraint|fetch failed/i.test(message) ? "No se pudo guardar la acción. Puede existir otra propuesta en curso para esta web; actualiza y revisa su estado." : message.slice(0, 500) }, { status: 400 });
  }
}
